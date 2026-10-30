/* ==================================================================
   POPUP — normally nobody touches this file's UI except to click one
   button. "Pair with my VM" asks the agent for its token, so the token
   never has to be copied between two windows.

   Everything below the fold is escape hatches for the day arena.ai
   changes its markup, or the day the agent is not on 127.0.0.1:8787.
   ================================================================== */
const DEFAULTS = { base: "http://127.0.0.1:8787", token: "", maxSteps: 24,
                   selectors: { composer: "", sendButton: "", reply: "" } };
const $ = id => document.getElementById(id);
const dot = $("dot"), statusEl = $("status");

function setStatus(state, text, good = false) {
  dot.className = "dot" + (state ? " " + state : "");
  statusEl.className = "status" + (good ? " good" : "");
  statusEl.textContent = text;
}

async function load() {
  const v = await chrome.storage.local.get(DEFAULTS);
  $("base").value = v.base || DEFAULTS.base;
  $("token").value = v.token || "";
  $("maxSteps").value = v.maxSteps || DEFAULTS.maxSteps;
  const s = { ...DEFAULTS.selectors, ...(v.selectors || {}) };
  $("selComposer").value = s.composer || "";
  $("selSend").value = s.sendButton || "";
  $("selReply").value = s.reply || "";
}

async function save() {
  const base = $("base").value.trim() || DEFAULTS.base;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(base)) {
    setStatus("down", "Use a loopback address, or tunnel the VM to one.");
    return false;
  }
  await chrome.storage.local.set({
    base,
    token: $("token").value.trim(),
    maxSteps: Math.max(1, Math.min(100, Number($("maxSteps").value) || 24)),
    selectors: {
      composer: $("selComposer").value.trim(),
      sendButton: $("selSend").value.trim(),
      reply: $("selReply").value.trim(),
    },
  });
  return true;
}

function health() {
  chrome.runtime.sendMessage({ type: "akb:health" }, h => {
    if (!h) return setStatus("down", "No response from the extension worker. Reload it.");
    if (h.ok) return setStatus("up", `Connected to ${h.user}@${h.host}.\nNow press CONNECT in the panel on arena.ai.`, true);
    if (h.error === "wrong-token") return setStatus("down", "Reachable, but the token was rejected. Connect again.");
    if (h.error === "no-token") return setStatus("down", "Not connected yet — click Test connection.");
    if (h.error === "offline") {
      return setStatus("down", "Nothing listening on 8787.\nIs the agent running in Kali, and is the port forward set up?");
    }
    setStatus("down", "Failed: " + h.error);
  });
}

function pair() {
  setStatus("", "Testing…");
  chrome.runtime.sendMessage({ type: "akb:pair" }, r => {
    if (!r) return setStatus("down", "No response from the extension worker. Reload it.");
    if (r.ok) {
      $("token").value = r.token || "";
      return health();
    }
    if (r.error === "offline") {
      return setStatus("down", "Nothing listening on 8787.\nIs the agent running in Kali, and is the port forward set up?");
    }
    if (r.error === "pairing-disabled") {
      return setStatus("down", "Pairing is switched off on this agent (started with --no-pair).\nPaste the token under Advanced.");
    }
    if (r.error === "pairing-origin") {
      return setStatus("down", "The VM refused this extension's pairing.\nPaste the token under Advanced:\n  sudo cat /root/.arena-bridge/token");
    }
    setStatus("down", "Connect failed: " + r.error + "\nPaste the token under Advanced instead.");
  });
}

$("pair").addEventListener("click", pair);
$("test").addEventListener("click", async () => { if (await save()) { setStatus("", "Testing…"); health(); } });
$("save").addEventListener("click", async () => { if (await save()) setStatus("", "Saved."); });

load().then(health);
