/* Popup: connection settings, in one place, with a real test button.
   Nothing here is clever — but "Test" has to perform the same call the
   worker will, otherwise it is a lie. */
const DEFAULTS = { base: "http://127.0.0.1:8787", token: "", trustPage: false };

const $ = id => document.getElementById(id);
const dot = $("dot");
const statusEl = $("status");

function setStatus(state, text) {
  dot.className = "dot" + (state ? " " + state : "");
  statusEl.textContent = text;
}

async function load() {
  const v = await chrome.storage.local.get(DEFAULTS);
  $("base").value = v.base || DEFAULTS.base;
  $("token").value = v.token || "";
  $("trust").checked = !!v.trustPage;
}

async function save() {
  const base = $("base").value.trim() || DEFAULTS.base;
  const token = $("token").value.trim();
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(base)) {
    setStatus("down", "Use a loopback address, or tunnel the remote VM to one.");
    return false;
  }
  await chrome.storage.local.set({ base, token, trustPage: $("trust").checked });
  return true;
}

async function test() {
  if (!(await save())) return;
  setStatus("", "Testing…");
  try {
    chrome.runtime.sendMessage({ type: "bridge:health" }, h => {
      if (!h) return setStatus("down", "No response from the extension worker.");
      if (h.ok) {
        setStatus("up", `Connected to ${h.user}@${h.host} (agent ${h.agent}).`);
      } else if (h.error === "wrong-token") {
        setStatus("down", "Reachable, but the token was rejected.");
      } else if (h.error === "no-token") {
        setStatus("down", "Paste the token from the agent's console.");
      } else if (h.error === "offline") {
        setStatus("down", "Nothing listening. Is the agent running / tunnel open?");
      } else {
        setStatus("down", "Failed: " + h.error);
      }
    });
  } catch (e) {
    setStatus("down", "Extension error: " + e.message);
  }
}

$("test").addEventListener("click", test);
$("save").addEventListener("click", async () => {
  if (await save()) setStatus("", "Saved.");
});
$("trust").addEventListener("change", () => save());

load().then(test);
