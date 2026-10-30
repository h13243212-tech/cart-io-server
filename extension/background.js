/* ==================================================================
   BACKGROUND — the worker that owns the loop state and the bridge call.
   ------------------------------------------------------------------
   Deliberately the only place that decides anything, because it can be an
   ES module and therefore import lib/loop.js — the same file the test
   suite exercises. The code that runs is the code that is tested; the
   content script only moves text around.

   It is also the only context allowed to reach http://127.0.0.1 (an https
   page cannot, and a content script inherits the page's restrictions).
   ================================================================== */
import { nextAction, makeResultMessage, summariseCommand, LIMITS } from "./lib/loop.js";

const DEFAULTS = { base: "http://127.0.0.1:8787", token: "", maxSteps: LIMITS.maxSteps };

/** Per-tab loop state: what has already run, and how many steps deep. */
const tabs = new Map();
function stateOf(tabId) {
  const key = tabId ?? -1;
  if (!tabs.has(key)) tabs.set(key, { seen: new Set(), steps: 0, armed: false });
  return tabs.get(key);
}

async function config() {
  const v = await chrome.storage.local.get(DEFAULTS);
  return {
    base: String(v.base || DEFAULTS.base).replace(/\/+$/, ""),
    token: String(v.token || ""),
    maxSteps: Math.max(1, Math.min(100, Number(v.maxSteps) || LIMITS.maxSteps)),
  };
}

async function call(path, init) {
  const { base, token } = await config();
  if (!token) return { error: "no-token" };
  try {
    const res = await fetch(base + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
    });
    return { res };
  } catch {
    return { error: "offline" };
  }
}

async function health() {
  const { res, error } = await call("/health", { method: "GET" });
  if (error) return { ok: false, error };
  if (res.status === 401) return { ok: false, error: "wrong-token" };
  if (!res.ok) return { ok: false, error: "http-" + res.status };
  try { return await res.json(); } catch { return { ok: false, error: "bad-response" }; }
}

/** Ask the agent for its token, so the user never copies one.
    Works only because this worker's fetch carries Origin:
    chrome-extension://<id>, which a web page cannot set. The agent still
    gates on it and logs every pairing. */
async function pair() {
  const { base } = await config();
  let res;
  try {
    res = await fetch(base + "/pair", { method: "GET" });
  } catch {
    return { ok: false, error: "offline" };
  }
  if (res.status === 403) {
    // the agent says which kind of refusal this is; guessing was misleading
    let code = "pairing-origin";
    try { code = (await res.json()).code === "disabled" ? "pairing-disabled" : "pairing-origin"; } catch { /* keep */ }
    return { ok: false, error: code };
  }
  if (!res.ok) return { ok: false, error: "http-" + res.status };
  try {
    const j = await res.json();
    if (!j || !j.token) return { ok: false, error: "bad-response" };
    await chrome.storage.local.set({ token: j.token });
    return { ok: true, token: j.token, host: j.host || "" };
  } catch {
    return { ok: false, error: "bad-response" };
  }
}

/** One command, one JSON result. */
async function runCommand(cmd, timeout_s = 120) {
  const { res, error } = await call("/run", {
    method: "POST",
    body: JSON.stringify({ cmd, timeout_s, cap: 6000 }),
  });
  if (error) return { code: null, out: "", err: error, error };
  if (res.status === 401) return { code: null, out: "", err: "token rejected", error: "wrong-token" };
  if (res.status === 429) return { code: null, out: "", err: "busy: too many concurrent commands", error: "busy" };
  if (!res.ok) {
    let msg = "http-" + res.status;
    try { msg = (await res.json()).error || msg; } catch { /* keep */ }
    return { code: null, out: "", err: msg, error: msg };
  }
  try { return await res.json(); } catch { return { code: null, out: "", err: "bad response", error: "bad-response" }; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  const st = stateOf(sender?.tab?.id);

  if (msg.type === "akb:health") {
    health().then(sendResponse);
    return true;
  }

  if (msg.type === "akb:pair") {
    pair().then(sendResponse);
    return true;
  }

  if (msg.type === "akb:reset") {
    st.seen.clear();
    st.steps = 0;
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "akb:tick") {
    (async () => {
      const cfg = await config();
      st.armed = true;

      const decision = nextAction({
        text: String(msg.text || ""),
        seen: st.seen,
        armed: true,
        steps: st.steps,
        maxSteps: cfg.maxSteps,
      });

      if (decision.action === "stop") {
        st.armed = false;
        sendResponse({ action: "stop", reason: decision.reason, steps: st.steps });
        return;
      }
      if (decision.action !== "run") {
        sendResponse({ action: "idle", steps: st.steps });
        return;
      }

      // Mark it as consumed BEFORE awaiting, so a second observer firing
      // on the same text cannot submit the same command twice.
      st.seen.add(decision.key);
      st.steps++;

      const result = await runCommand(decision.cmd);
      const h = result.error ? null : await health();

      sendResponse({
        action: "run",
        cmd: decision.cmd,
        summary: `${result.error ? "error: " + result.error : "exit " + result.code} · ${result.ms ?? 0}ms`,
        message: makeResultMessage(result),
        steps: st.steps,
        host: h?.ok ? `${h.user}@${h.host}` : result.error || "",
      });
    })();
    return true;
  }

  return false;
});

void summariseCommand;
