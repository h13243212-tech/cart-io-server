/* ==================================================================
   CONTENT SCRIPT — the panel on the page.
   ------------------------------------------------------------------
   Runs only on arena.ai. Content scripts cannot be ES modules, so this
   file is self-contained; everything needing tests lives in the worker.

   TWO RULES THIS FILE FOLLOWS

   1. Command output is rendered with textContent, never innerHTML. The
      output can contain anything a shell can print — a filename with a
      <script> tag in it will not be executed because it is never parsed
      as HTML.

   2. A page-initiated command is never executed silently. JavaScript on
      arena.ai can post a message asking to run something, but by default
      it lands in a confirmation chip that a human must click. "The page
      asked" is not consent, because any third-party script on that page
      could ask too.
   ================================================================== */
(() => {
  "use strict";
  if (window.__arenaBridgeLoaded) return;
  window.__arenaBridgeLoaded = true;

  const MAX_SELECTION = 8000;
  let seq = 0;
  let trustPage = false;
  let panel = null;
  let logEl = null;
  let chip = null;

  /* ---------- storage ---------- */
  try {
    chrome.storage.local.get({ trustPage: false }, v => { trustPage = !!v.trustPage; });
  } catch { /* storage unavailable: stay in the safe default */ }

  /* ---------- UI ---------- */
  function build() {
    panel = document.createElement("div");
    panel.id = "ab-panel";
    panel.innerHTML = `
      <div class="ab-head">
        <span class="ab-dot" data-state="unknown"></span>
        <span class="ab-title">VM</span>
        <span class="ab-host">…</span>
        <button class="ab-btn ab-collapse" title="collapse">–</button>
      </div>
      <div class="ab-body">
        <div class="ab-log" aria-live="polite"></div>
        <form class="ab-form">
          <span class="ab-prompt">$</span>
          <input class="ab-input" type="text" spellcheck="false" autocomplete="off"
                 placeholder="command to run on the VM" />
          <button class="ab-btn ab-run" type="submit">Run</button>
        </form>
      </div>`;
    document.documentElement.appendChild(panel);

    logEl = panel.querySelector(".ab-log");
    const dot = panel.querySelector(".ab-dot");
    const hostEl = panel.querySelector(".ab-host");
    const body = panel.querySelector(".ab-body");
    const input = panel.querySelector(".ab-input");

    panel.querySelector(".ab-collapse").addEventListener("click", () => {
      panel.classList.toggle("ab-collapsed");
    });

    panel.querySelector(".ab-form").addEventListener("submit", e => {
      e.preventDefault();
      const cmd = input.value.trim();
      if (!cmd) return;
      input.value = "";
      run(cmd);
    });

    // stop clicks in the panel from reaching the page (and vice versa)
    panel.addEventListener("mousedown", e => e.stopPropagation());
    panel.addEventListener("mouseup", e => e.stopPropagation());

    panel.__setState = (s, label) => {
      dot.dataset.state = s;
      hostEl.textContent = label || "";
    };
    panel.__body = body;

    const setState = panel.__setState;
    return { setState, input };
  }

  function appendRow(cls, text) {
    if (!logEl) return;
    const row = document.createElement("div");
    row.className = "ab-row ab-" + cls;
    row.textContent = text;                  // never innerHTML
    logEl.appendChild(row);
    while (logEl.childElementCount > 500) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function health() {
    try {
      chrome.runtime.sendMessage({ type: "bridge:health" }, h => {
        if (!h) { panel.__setState("down", "no worker"); return; }
        if (h.ok) {
          const label = (h.summary && h.summary.label) || `${h.user}@${h.host}`;
          panel.__setState("up", label);
        } else {
          panel.__setState("down", h.error === "wrong-token" ? "bad token" : h.error);
        }
      });
    } catch {
      panel.__setState("down", "extension offline");
    }
  }

  function run(cmd, note) {
    const runId = "r" + ++seq;
    appendRow("meta", (note ? note + " " : "") + "$ " + cmd);
    try {
      chrome.runtime.sendMessage({ type: "bridge:exec", runId, payload: { cmd } }, res => {
        if (!res) appendRow("err", "[no response from extension]");
      });
    } catch {
      appendRow("err", "[extension is not available]");
    }
    if (panel.classList.contains("ab-collapsed")) {
      panel.classList.remove("ab-collapsed");
    }
  }

  /* ---------- results from the worker ---------- */
  try {
    chrome.runtime.onMessage.addListener(msg => {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "bridge:event") {
        const ev = msg.ev || {};
        if (ev.t === "out") appendRow("out", String(ev.d ?? ""));
        else if (ev.t === "err") appendRow("err", String(ev.d ?? ""));
        else if (ev.t === "start") { /* already echoed the command */ }
        else if (ev.t === "error") appendRow("err", "error: " + (ev.message ?? "unknown"));
        else if (ev.t === "truncated") appendRow("meta", "[output truncated]");
        else if (ev.t === "exit") {
          const bits = [];
          if (ev.timedOut) bits.push("timed out");
          else if (ev.killed) bits.push("killed");
          bits.push(ev.code === null ? "no exit code" : "exit " + ev.code);
          if (typeof ev.ms === "number") bits.push(ev.ms + "ms");
          appendRow(ev.code === 0 || ev.timedOut ? "meta" : "err", "[" + bits.join(" · ") + "]");
        }
      } else if (msg.t === "bridge:done") {
        health();
      }
    });
  } catch { /* ignore */ }

  /* ---------- "run selection" chip ---------- */
  function hideChip() {
    if (chip) { chip.remove(); chip = null; }
  }

  function showChip(text, rect, mode) {
    hideChip();
    chip = document.createElement("button");
    chip.id = "ab-chip";
    chip.textContent = mode === "confirm" ? "▶ run on VM?" : "▶ VM";
    chip.title = text.length > 120 ? text.slice(0, 120) + "…" : text;
    document.documentElement.appendChild(chip);

    const x = Math.min(window.innerWidth - 130, Math.max(4, rect.left));
    const y = Math.min(window.innerHeight - 46, rect.bottom + 8);
    chip.style.left = x + "px";
    chip.style.top = y + "px";

    chip.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); });
    chip.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      hideChip();
      run(text, mode === "confirm" ? "(page request)" : "(selection)");
    });
    return chip;
  }

  document.addEventListener("mouseup", e => {
    if (panel && panel.contains(e.target)) return;
    if (chip && chip.contains(e.target)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? String(sel).trim() : "";
      if (!text || text.length > MAX_SELECTION) { hideChip(); return; }
      let rect;
      try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { return; }
      if (!rect || (!rect.width && !rect.height)) { hideChip(); return; }
      showChip(text, rect, "run");
    }, 0);
  });

  document.addEventListener("mousedown", e => {
    if (chip && chip.contains(e.target)) return;
    hideChip();
  });

  /* ---------- page API ----------
     Documented in README. A page can request a command with:
       window.postMessage({ source: "arena-page", type: "bridge.exec", cmd }, origin)
     It is refused unless the user has ticked "trust this page" in the
     popup; otherwise it becomes a chip the human must approve. */
  window.addEventListener("message", event => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== "arena-page") return;

    if (data.type === "bridge.ping") {
      window.postMessage({ source: "arena-bridge", type: "pong" }, window.location.origin);
      return;
    }
    if (data.type === "bridge.exec") {
      const cmd = typeof data.cmd === "string" ? data.cmd.trim() : "";
      if (!cmd || cmd.length > MAX_SELECTION) return;
      if (trustPage) {
        run(cmd, "(page · trusted)");
      } else {
        const rect = { left: Math.max(8, window.innerWidth / 2 - 60), bottom: window.innerHeight - 90 };
        showChip(cmd, rect, "confirm");
      }
    }
  });

  /* ---------- boot ---------- */
  const init = () => {
    if (document.documentElement) {
      build();
      health();
      setInterval(health, 15000);
    } else {
      setTimeout(init, 60);
    }
  };
  init();
})();
