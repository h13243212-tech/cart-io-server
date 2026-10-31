/* ==================================================================
   CONTENT — panel, watcher, and the loop driver on the page.
   ------------------------------------------------------------------
   Drives the fake tool loop: watch the reply, ask the worker what to do,
   type the result back, press send. All decisions live in the worker
   (lib/loop.js, tested); this file only touches the DOM.

   Three safety properties, because this runs arbitrary shell commands:

   1. DISARMED BY DEFAULT. Nothing executes until the human clicks Arm.
   2. Settle debounce. The model streams; a half-written fence must never
      be executed. We wait for the DOM to stop changing.
   3. Every step is shown before it runs, with the command, exit code and
      byte count, so the panel is an audit log rather than decoration.
   ================================================================== */
(() => {
  "use strict";
  if (window.__AKBLoaded) return;
  window.__AKBLoaded = true;

  const Site = window.AKBSite;
  const SETTLE_MS = 700;
  const DEFAULTS = {
    armed: false,
    maxSteps: 24,
    autoSubmit: true,
    selectors: { composer: "", sendButton: "", reply: "" },
  };
  const PROMPT = window.AKB_PROMPT || "";

  let cfg = { ...DEFAULTS };
  let armed = false;
  let started = false;
  let steps = 0;
  let lastSeenText = "";
  let lastIdleText = "";   // so "saw a block, cannot run it" is said once
  let lastEmptyText = "";  // and "no block at all" is said once
  let busySince = 0;       // a worker that never answers must not freeze the loop
  let lastInjected = "";
  let busy = false;
  let settleTimer = null;
  let panel, logEl, dotEl, armBtn, stepsEl, manualBar;

  /* ---------------- panel ---------------- */
  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "akb-panel";
    panel.innerHTML = `
      <div class="akb-head">
        <span class="akb-dot" data-state="unknown"></span>
        <span class="akb-name">KALI</span>
        <span class="akb-host">…</span>
        <button class="akb-mini" data-act="diag" title="diagnose page selectors">?</button>
        <button class="akb-mini" data-act="report" title="download a report for the developer">⤓</button>
        <button class="akb-mini" data-act="collapse" title="collapse">–</button>
      </div>
      <div class="akb-body">
        <div class="akb-controls">
          <button class="akb-arm" data-act="arm">CONNECT</button>
          <button class="akb-mini" data-act="reset" title="reset step counter">↺</button>
          <span class="akb-steps">0/${DEFAULTS.maxSteps}</span>
        </div>
        <div class="akb-runbox">
          <input class="akb-input" placeholder="type a command to test the VM…" spellcheck="false" />
          <button class="akb-mini" data-act="run">run</button>
        </div>
        <div class="akb-log" aria-live="polite"></div>
        <div class="akb-manual" hidden>
          <button class="akb-mini" data-act="manual">⚠ auto-send failed — click to place the result yourself</button>
        </div>
      </div>`;
    document.documentElement.appendChild(panel);

    logEl = panel.querySelector(".akb-log");
    dotEl = panel.querySelector(".akb-dot");
    armBtn = panel.querySelector(".akb-arm");
    stepsEl = panel.querySelector(".akb-steps");
    manualBar = panel.querySelector(".akb-manual");

    panel.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.target?.classList?.contains("akb-input")) {
        e.preventDefault();
        runTyped();
      }
    });

    panel.addEventListener("click", e => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      e.stopPropagation();
      if (act === "arm") (started ? setArmed(!armed) : startSession());
      else if (act === "reset") resetRun();
      else if (act === "collapse") panel.classList.toggle("akb-collapsed");
      else if (act === "diag") runDiagnostics();
      else if (act === "report") makeReport();
      else if (act === "run") runTyped();
      else if (act === "manual") placeManually();
    });
    panel.addEventListener("mousedown", e => e.stopPropagation());
  }

  const logLines = [];   // mirrored for the report file

  function row(cls, text) {
    logLines.push(`${new Date().toISOString().slice(11, 19)} ${cls} ${text}`);
    if (logLines.length > 400) logLines.shift();
    if (!logEl) return;
    const d = document.createElement("div");
    d.className = "akb-row akb-" + cls;
    d.textContent = text;              // never innerHTML
    logEl.appendChild(d);
    while (logEl.childElementCount > 300) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setDot(state, label) {
    if (dotEl) dotEl.dataset.state = state;
    const host = panel?.querySelector(".akb-host");
    if (host && label != null) host.textContent = label;
  }

  function setArmed(v) {
    armed = v;
    started = true;
    armBtn.textContent = v ? "ARMED — click to stop" : "CONNECT";
    armBtn.classList.toggle("akb-on", v);
    panel.classList.toggle("akb-armed", v);
    row(v ? "warn" : "meta", v ? "ARMED — the model can now run commands" : "disarmed");
    if (v) {
      steps = 0;
      lastSeenText = "";
      chrome.runtime.sendMessage({ type: "akb:reset" });
      tick(true);
    }
  }

  /** One click: pair if needed, teach the model the format, send it, arm.
      Pairing here (not in the popup) is the point — the panel is where the
      user already is, and a token is not something anyone should handle. */
  function startSession() {
    row("meta", "── connecting ──");
    const ask = (type) => new Promise(r => chrome.runtime.sendMessage({ type }, r));

    (async () => {
      let h = await ask("akb:health");

      if (h && h.error === "no-token") {
        row("meta", "asking the VM for a token…");
        const p = await ask("akb:pair");
        if (!p || !p.ok) {
          row("err", p?.error === "pairing-disabled"
            ? "pairing is off on the VM (--no-pair) — paste the token in the extension popup"
            : p?.error === "pairing-origin"
              ? "the VM refused this extension's pairing — its log says why; paste the token instead"
              : "cannot reach the VM — is the agent running?");
          setDot("down", "offline");
          return;
        }
        h = await ask("akb:health");
      }

      if (!h || !h.ok) {
        row("err", !h || h.error === "offline"
          ? "cannot reach the VM — is the agent running in Kali?"
          : "the VM rejected the token — paste a fresh one in the extension popup");
        setDot("down", h?.error || "offline");
        return;
      }

      setDot("up", `${h.user}@${h.host}`);
      row("good", `connected to ${h.user}@${h.host}`);

      const { el: composer } = Site.findComposer(cfg.selectors.composer);
      if (!composer) {
        row("err", "no chat input box found — press ? to diagnose");
        return;
      }
      if (!PROMPT) {
        row("err", "setup prompt missing from the extension");
        return;
      }

      const typed = Site.setComposerText(composer, PROMPT);
      if (!typed) {
        row("err", "could not type into the chat box — press ? to diagnose");
        return;
      }
      const { el: sendBtn } = Site.findSendButton(composer, cfg.selectors.sendButton);
      setTimeout(() => {
        const how = Site.submit(composer, sendBtn);
        if (how === "none") { row("err", "could not send — press Enter yourself"); return; }
        row("meta", "waiting for READY, then just ask for something");
        lastSeenText = "";
        setTimeout(() => setArmed(true), 900);
      }, 80);
    })();
  }

  /** Everything needed to diagnose this without a browser in front of me. */
  function makeReport() {
    const d = Site.diagnose(cfg.selectors);
    const parts = [];
    parts.push("arena-kali report");
    parts.push("version : " + chrome.runtime.getManifest().version);
    parts.push("url     : " + location.href);
    parts.push("time    : " + new Date().toISOString());
    parts.push("armed   : " + armed + "  started: " + started + "  steps: " + steps);
    parts.push("");
    parts.push("--- diagnose ---");
    parts.push(JSON.stringify(d, null, 2));
    parts.push("");
    parts.push("--- every <pre> on the page ---");
    const pres = [...document.querySelectorAll("pre")];
    parts.push("count: " + pres.length);
    pres.slice(-6).forEach((pre, i) => {
      parts.push(`[${i}] class=${pre.className || "-"} data-lang=${pre.getAttribute("data-language") || "-"}`);
      parts.push("    text: " + JSON.stringify((pre.innerText || "").slice(0, 160)));
    });
    parts.push("");
    parts.push("--- reply element html (truncated) ---");
    const el = Site.findLastReplyText(cfg.selectors.reply).el;
    parts.push(el ? (el.outerHTML || "").slice(0, 12000) : "(not found)");
    parts.push("");
    parts.push("--- panel log ---");
    parts.push(...logLines);

    const blob = new Blob([parts.join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "arena-kali-report.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    row("good", "report downloaded — send me arena-kali-report.txt");
  }

  /** Type a command here to prove the VM answers, with the chat out of the way. */
  function runTyped() {
    const input = panel.querySelector(".akb-input");
    const cmd = (input?.value || "").trim();
    if (!cmd) { row("warn", "type a command first"); return; }
    row("cmd", "$ " + cmd);
    chrome.runtime.sendMessage({ type: "akb:exec", cmd }, (res) => {
      if (!res) { row("err", "no answer from the extension worker"); return; }
      if (!res.ok) {
        row("err", "bridge: " + (res.result?.error || "failed"));
        setDot("down", res.result?.error || "failed");
        return;
      }
      const r = res.result || {};
      const body = (r.out || "") + (r.err ? (r.out ? "\n--- stderr ---\n" : "") + r.err : "");
      row("meta", `  ↳ exit ${r.code}${r.timedOut ? " (timed out)" : ""} · ${r.ms || 0}ms`);
      String(body || "(no output)").split("\n").slice(0, 12).forEach((l) => row("out", "  " + l));
      if (input) input.value = "";
      setDot("up", "connected");
    });
  }

  function resetRun() {
    steps = 0;
    lastSeenText = "";
    stepsEl.textContent = `0/${cfg.maxSteps} steps`;
    chrome.runtime.sendMessage({ type: "akb:reset" });
    row("meta", "run reset");
  }

  function setSteps(n) {
    steps = n;
    stepsEl.textContent = `${n}/${cfg.maxSteps} steps`;
  }

  /* ---------------- the loop ---------------- */
  function settle() {
    if (busy && Date.now() - busySince > 20000) {
      busy = false;                       // the worker died mid-request
      row("warn", "worker stopped answering — loop resumed");
    }
    if (!armed || busy) return;
    const { text, blocks } = Site.findLastReplyText(cfg.selectors.reply);
    if (!text) return;
    if (text === lastSeenText) return;
    // never treat our own injected result as a new instruction
    if (lastInjected && text.startsWith(lastInjected.slice(0, 60))) return;
    if (text.length < 8) return;
    if (!blocks.length && !text.includes("```")) {
      // The exact hole that made earlier rounds unanswerable: a reply we
      // could read, with nothing runnable in it, used to say nothing.
      if (lastEmptyText !== text) {
        lastEmptyText = text;
        const d = Site.diagnose(cfg.selectors);
        row("warn", `reply seen (${text.length} chars via ${d.reply.how}) — no code block found`);
      }
      return;
    }
    tick(false, text, blocks);
  }

  function tick(force = false, text = null, blocks = null) {
    if (!armed || busy) return;
    const reply = text == null ? Site.findLastReplyText(cfg.selectors.reply) : null;
    const body = text ?? reply.text;
    const codeBlocks = blocks ?? reply?.blocks ?? [];
    if (!body) return;
    if (!force && body === lastSeenText) return;
    lastSeenText = body;
    busy = true;
    busySince = Date.now();

    chrome.runtime.sendMessage({ type: "akb:tick", text: body, blocks: codeBlocks }, res => {
      busy = false;
      if (!res) { row("err", "no answer from the extension worker"); return; }
      if (res.error) { row("err", "bridge: " + res.error); setDot("down", res.error); return; }
      setDot("up", res.host || "connected");
      if (typeof res.steps === "number") setSteps(res.steps);

      if (res.action === "stop") {
        row("warn", "stopped: " + res.reason);
        setArmed(false);
        return;
      }
      if (res.action === "idle") {
        // A reply with a code block that did not run is the most confusing
        // state this thing has. Say what was seen, once per reply.
        if (res.saw && res.saw.blocks && lastIdleText !== body) {
          lastIdleText = body;
          const langs = (res.saw.langs || []).map((l) => l || "untagged").join(", ");
          row("warn", `saw ${res.saw.blocks} code block(s) [${langs}] — ${res.reason || "not executable"}`);
        }
        return;
      }
      if (res.action !== "run") return;

      lastIdleText = "";
      row("cmd", "$ " + res.cmd);
      row("meta", `  ↳ ${res.summary || ""}`);
      deliver(res.message);
    });
  }

  function deliver(message) {
    if (!message) return;
    const { el: composer } = Site.findComposer(cfg.selectors.composer);
    if (!composer) { showManual(message); return; }

    const ok = Site.setComposerText(composer, message);
    if (!ok) { showManual(message); return; }

    if (!cfg.autoSubmit) {
      row("meta", "typed into the box — press Enter yourself");
      return;
    }
    const { el: sendBtn } = Site.findSendButton(composer, cfg.selectors.sendButton);
    setTimeout(() => {
      const how = Site.submit(composer, sendBtn);
      if (how === "none") { showManual(message); return; }
      lastInjected = message;
      row("meta", `  ↳ sent result back (${how})`);
    }, 80);
  }

  let pendingManual = "";
  function showManual(message) {
    pendingManual = message;
    manualBar.hidden = false;
    row("err", "could not auto-send — use the warning button above");
  }
  function placeManually() {
    if (!pendingManual) return;
    const { el: composer } = Site.findComposer(cfg.selectors.composer);
    if (composer) {
      Site.setComposerText(composer, pendingManual);
      lastInjected = pendingManual;
      row("meta", "result typed into the box — send it yourself");
    } else {
      navigator.clipboard?.writeText(pendingManual);
      row("meta", "no input box found — result copied to clipboard");
    }
    pendingManual = "";
    manualBar.hidden = true;
  }

  /* ---------------- diagnostics ---------------- */
  function runDiagnostics() {
    const d = Site.diagnose(cfg.selectors);
    row("meta", "── diagnostics ──");
    row("meta", "extension v" + chrome.runtime.getManifest().version);
    row(d.composer.found ? "good" : "err",
      `input box: ${d.composer.found ? d.composer.tag + " via " + d.composer.how : "NOT FOUND"}`);
    row(d.sendButton.found ? "good" : "warn",
      `send button: ${d.sendButton.found ? d.sendButton.how : "not found (will press Enter)"}`);
    row(d.reply.found ? "good" : "err",
      `last reply: ${d.reply.found ? `${d.reply.chars} chars via ${d.reply.how}` : "NOT FOUND"}`);
    if (d.reply.blocks) {
      row("good", `code blocks in reply: ${d.reply.blocks} [${(d.reply.langs || []).join(", ")}]`);
    } else if (d.reply.hasFence) {
      row("good", "reply contains a fenced block ✓ (no rendered block found)");
    } else if (d.reply.found) {
      row("warn", "reply has no code block yet");
    }
    row("meta", `<pre> elements on the page: ${d.reply.presOnPage ?? "?"}`);
    row("meta", `visible editables: ${d.visibleEditables}`);
    if (!d.reply.found || !d.composer.found) {
      row("warn", "use the popup to set CSS selectors by hand");
    }
    return d;
  }

  /* ---------------- health ---------------- */
  function health() {
    chrome.runtime.sendMessage({ type: "akb:health" }, h => {
      if (!h) return setDot("down", "no worker");
      if (h.ok) setDot("up", `${h.user}@${h.host}`);
      else setDot("down", h.error === "wrong-token" ? "bad token" : h.error);
    });
  }

  /* ---------------- boot ---------------- */
  function start() {
    buildPanel();
    chrome.storage.local.get(DEFAULTS, v => {
      cfg = { ...DEFAULTS, ...v, selectors: { ...DEFAULTS.selectors, ...(v.selectors || {}) } };
      setSteps(0);
      stepsEl.textContent = `0/${cfg.maxSteps} steps`;
    });
    health();
    setInterval(health, 20000);

    const obs = new MutationObserver(() => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, SETTLE_MS);
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Belt and braces: if arena stops mutating (or the observer misses a
    // subtree), polling still notices a new reply. Cheap: one query every
    // 1.5s and settle() early-exits on unchanged text.
    setInterval(() => { if (armed && !busy) settle(); }, 1500);

    row("good", "press CONNECT — that is the whole setup");
    row("meta", "then ask for anything: it runs on your VM");
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
