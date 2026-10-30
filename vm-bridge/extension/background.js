/* ==================================================================
   BACKGROUND SERVICE WORKER
   ------------------------------------------------------------------
   This is the only context in the extension that is allowed to talk to
   http://127.0.0.1, and it exists for exactly one reason:

   An https page cannot fetch an http://127.0.0.1 URL. The browser blocks
   it as mixed content before the request leaves the tab, and CORS would
   block the response anyway. A service worker with host_permissions is
   exempt from both. That is the whole justification for building an
   extension instead of a snippet of page JavaScript.

   The worker holds no command logic: it forwards, streams and reports.
   All validation lives in lib/protocol.js so it can be tested in node.
   ================================================================== */
import { splitNdjson, normalizeExec, describeHealth } from "./lib/protocol.js";

const DEFAULTS = { base: "http://127.0.0.1:8787", token: "" };

async function config() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    base: String(stored.base || DEFAULTS.base).replace(/\/+$/, ""),
    token: String(stored.token || ""),
  };
}

async function request(path, init = {}) {
  const { base, token } = await config();
  if (!token) return { error: "no-token" };
  try {
    const res = await fetch(base + path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
        ...(init.headers || {}),
      },
    });
    return { res };
  } catch (e) {
    // Wrong port, VM down, agent not running, tunnel not open — all the same
    // to us, and all reported as "offline" rather than a raw TypeError.
    return { error: "offline", detail: String(e && e.message ? e.message : e) };
  }
}

async function health() {
  const { res, error, detail } = await request("/health", { method: "GET" });
  if (error) return { ok: false, error, detail };
  if (res.status === 401) return { ok: false, error: "wrong-token" };
  if (!res.ok) return { ok: false, error: "http-" + res.status };
  try {
    return await res.json();
  } catch {
    return { ok: false, error: "bad-response" };
  }
}

/**
 * Stream a command, relaying each event to the tab that asked for it.
 * Events are relayed as they arrive — the point of the whole exercise is
 * that `nmap` prints its first line immediately.
 */
async function runExec(tabId, runId, body) {
  const plan = normalizeExec(body);
  if (!plan.ok) {
    await relay(tabId, { t: "bridge:event", runId, ev: { t: "error", message: plan.error } });
    return { ok: false, error: plan.error };
  }

  const { res, error, detail } = await request("/exec", {
    method: "POST",
    body: JSON.stringify({ cmd: plan.cmd, timeout_s: plan.timeout_s }),
  });
  if (error) {
    await relay(tabId, { t: "bridge:event", runId, ev: { t: "error", message: error + (detail ? ": " + detail : "") } });
    return { ok: false, error };
  }
  if (res.status === 401) {
    await relay(tabId, { t: "bridge:event", runId, ev: { t: "error", message: "the VM rejected the token" } });
    return { ok: false, error: "unauthorized" };
  }
  if (!res.ok || !res.body) {
    let message = "http-" + res.status;
    try { message = (await res.json()).error || message; } catch { /* keep status */ }
    await relay(tabId, { t: "bridge:event", runId, ev: { t: "error", message } });
    return { ok: false, error: message };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let count = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = splitNdjson(buffer);
    buffer = rest;
    for (const ev of events) {
      count++;
      await relay(tabId, { t: "bridge:event", runId, ev });
      // Touching a chrome API on every event also keeps the service worker
      // alive during a long-running command, which MV3 otherwise suspends.
    }
  }

  await relay(tabId, { t: "bridge:done", runId, count });
  return { ok: true, count };
}

async function relay(tabId, message) {
  if (tabId == null) return;
  try { await chrome.tabs.sendMessage(tabId, message); } catch { /* tab closed */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "bridge:health") {
    health().then(h => sendResponse({ ...h, summary: describeHealth(h) }));
    return true;                                  // async response
  }

  if (msg.type === "bridge:exec") {
    const tabId = sender?.tab?.id ?? null;
    const runId = msg.runId ?? String(Date.now());
    runExec(tabId, runId, msg.payload).then(sendResponse).catch(e =>
      sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  return false;
});
