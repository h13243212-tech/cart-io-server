const DEFAULTS = { base: "http://127.0.0.1:8787", token: "", maxSteps: 24,
                   selectors: { composer: "", sendButton: "", reply: "" } };
const $ = id => document.getElementById(id);
const dot = $("dot"), statusEl = $("status");

const setStatus = (state, text) => {
  dot.className = "dot" + (state ? " " + state : "");
  statusEl.textContent = text;
};

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

function test() {
  chrome.runtime.sendMessage({ type: "akb:health" }, h => {
    if (!h) return setStatus("down", "No response from the worker.");
    if (h.ok) setStatus("up", `Connected to ${h.user}@${h.host} (agent ${h.agent}).`);
    else if (h.error === "wrong-token") setStatus("down", "Reachable, but the token was rejected.");
    else if (h.error === "no-token") setStatus("down", "Paste the token from the agent's console.");
    else if (h.error === "offline") setStatus("down", "Nothing listening. Agent running? Forward open?");
    else setStatus("down", "Failed: " + h.error);
  });
}

$("test").addEventListener("click", async () => { if (await save()) { setStatus("", "Testing…"); test(); } });
$("save").addEventListener("click", async () => { if (await save()) setStatus("", "Saved."); });
load().then(test);
