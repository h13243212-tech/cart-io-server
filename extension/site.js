/* ==================================================================
   SITE — the fragile half. All DOM guessing lives in this file.
   ------------------------------------------------------------------
   This is a classic content script (not a module), so it publishes itself
   on window.AKBSite for content.js.

   WHY THIS FILE IS SMALL AND DUMB
   Everything here is a guess about arena.ai's markup, and a guess cannot
   be unit-tested from a terminal. So it decides nothing: it finds things,
   types text, and reports exactly which selector matched. The decisions
   live in lib/loop.js, which is tested. When the site changes, only this
   file needs touching — and the Diagnose panel tells you which part broke.
   ================================================================== */
(() => {
  "use strict";

  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 8) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };

  const area = el => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };

  /** The chat input box. Override wins; otherwise biggest editable thing
   *  nearest the bottom of the viewport. */
  function findComposer(override) {
    if (override) {
      const el = document.querySelector(override);
      if (el) return { el, how: "override" };
    }
    const pool = [
      ...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'),
    ].filter(visible);
    if (!pool.length) return { el: null, how: "none" };

    // prefer contenteditable/textarea low on the page, then by size
    pool.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ba = ra.bottom + area(a) / 4000, bb = rb.bottom + area(b) / 4000;
      return bb - ba;
    });
    const el = pool[0];
    const how = el.tagName === "TEXTAREA" ? "textarea" : el.getAttribute("role") === "textbox" ? "role=textbox" : "contenteditable";
    return { el, how };
  }

  /** The button that sends. */
  function findSendButton(composer, override) {
    if (override) {
      const el = document.querySelector(override);
      if (el) return { el, how: "override" };
    }
    const scope = composer?.closest("form") || composer?.parentElement?.parentElement || document;
    const cands = [...scope.querySelectorAll("button, [role='button']")].filter(visible);
    const score = el => {
      const t = ((el.getAttribute("aria-label") || "") + " " + (el.getAttribute("data-testid") || "") + " " + (el.textContent || "")).toLowerCase();
      let s = 0;
      if (/send|submit|ask|→|↗/.test(t)) s += 10;
      if (el.type === "submit") s += 6;
      const r = el.getBoundingClientRect(), cr = composer?.getBoundingClientRect();
      if (cr) {
        const d = Math.hypot(r.left - cr.right, r.top - cr.bottom);
        if (d < 200) s += 4;                 // right next to the input
      }
      return s;
    };
    cands.sort((a, b) => score(b) - score(a));
    const el = cands[0];
    if (!el || score(el) < 6) return { el: null, how: "none" };
    return { el, how: (el.getAttribute("aria-label") || el.textContent || "button").trim().slice(0, 40) };
  }

  /**
   * Text of the most recent assistant reply.
   * Heuristic ladder: explicit role attributes first, then generic
   * markdown containers, then anything that looks like a message.
   */
  /* ------------------------------------------------------------------
     Rendered markdown keeps no backticks. arena.ai (like most chat UIs)
     turns a ```bash fence into a styled component with a language chip, so
     the reply's innerText is "Bash" + the code — and a fence parser sees
     nothing at all. Read the <pre> elements instead and carry the label
     along; the decision about whether it is executable stays in loop.js.
     ------------------------------------------------------------------ */
  const LANG_LABELS = new Set([
    "bash", "sh", "shell", "shellscript", "zsh", "fish", "ksh",
    "console", "shellsession", "terminal", "kali", "zos", "powershell", "ps1",
    "text", "plaintext", "txt", "python", "python3", "javascript", "js",
    "typescript", "ts", "json", "yaml", "yml", "html", "css", "sql",
    "ruby", "go", "rust", "c", "cpp", "java", "php",
  ]);

  /** The language a code block claims, from the most reliable source first. */
  function langOf(pre, codeEl, code) {
    const cls = typeof codeEl.className === "string" ? codeEl.className : "";
    let lang = (cls.match(/language-([\w+#.-]+)/i) || [])[1] || "";
    if (!lang) lang = pre.getAttribute("data-language") || "";
    if (!lang) {
      const holder = pre.parentElement;
      if (holder) {
        lang = [...holder.querySelectorAll("*")]
          .filter((n) => n.children.length === 0)
          .map((n) => (n.textContent || "").trim())
          .find((t) => t && t.length <= 20 && LANG_LABELS.has(t.toLowerCase())) || "";
      }
    }
    return lang.toLowerCase();
  }

  /** Every code block in a reply, with the language its header displays. */
  function codeBlocksIn(root) {
    if (!root || !root.querySelectorAll) return [];
    const out = [];
    for (const pre of root.querySelectorAll("pre")) {
      const codeEl = pre.querySelector("code") || pre;
      let code = codeEl.innerText || codeEl.textContent || "";
      const lang = langOf(pre, codeEl, code);
      // a chip rendered inside the <pre> leaks into innerText as line one
      const first = code.split("\n")[0].trim().toLowerCase();
      if (code.split("\n").length > 1 && LANG_LABELS.has(first)) {
        code = code.split("\n").slice(1).join("\n");
      }
      if (code.trim()) out.push({ lang, code });
    }
    return out;
  }

  function findLastReplyText(override) {
    if (override) {
      const nodes = [...document.querySelectorAll(override)];
      if (nodes.length) {
        const el = nodes[nodes.length - 1];
        return {
          el, text: el.innerText || el.textContent || "",
          blocks: codeBlocksIn(el), how: "override",
        };
      }
    }
    const ladders = [
      ['[data-message-author-role="assistant"]', "author-role"],
      ['[data-testid*="assistant" i]', "testid"],
      ['.markdown, .prose, [class*="markdown"]', "markdown"],
      ['[class*="message"]:not([class*="user"]):not([class*="input"])', "message-class"],
    ];
    for (const [sel, how] of ladders) {
      let nodes;
      try { nodes = [...document.querySelectorAll(sel)].filter(visible); } catch { continue; }
      if (!nodes.length) continue;
      // the reply is the last one on the page with real content
      for (let i = nodes.length - 1; i >= 0; i--) {
        const text = (nodes[i].innerText || "").trim();
        if (text.length > 0) return { el: nodes[i], text, blocks: codeBlocksIn(nodes[i]), how };
      }
    }
    return { el: null, text: "", blocks: [], how: "none" };
  }

  /** Type into the chat box in a way React/Lexical editors actually see. */
  function setComposerText(el, text) {
    if (!el) return false;
    el.focus();

    // clear whatever the model or the user left there
    try {
      if (el.isContentEditable) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      } else if (el.select) {
        el.select();
      }
    } catch { /* ignore */ }

    // 1. paste event: the most reliable path into a rich-text editor
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      if ((el.innerText || el.value || "").includes(text.slice(0, 40))) return true;
    } catch { /* fall through */ }

    // 2. execCommand insertText — deprecated but widely supported
    try {
      if (document.execCommand("insertText", false, text)) {
        if ((el.innerText || el.value || "").includes(text.slice(0, 40))) return true;
      }
    } catch { /* fall through */ }

    // 3. last resort: write directly and announce it
    try {
      if (el.isContentEditable) el.innerText = text;
      else el.value = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
      return true;
    } catch {
      return false;
    }
  }

  function submit(composer, sendButton) {
    if (sendButton && visible(sendButton)) {
      sendButton.click();
      return "click";
    }
    if (!composer) return "none";
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    composer.dispatchEvent(new KeyboardEvent("keydown", opts));
    composer.dispatchEvent(new KeyboardEvent("keyup", opts));
    return "enter";
  }

  /** Everything the Diagnose button reports. */
  function diagnose(overrides = {}) {
    const c = findComposer(overrides.composer);
    const s = findSendButton(c.el, overrides.sendButton);
    const r = findLastReplyText(overrides.reply);
    const editables = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(visible).length;
    return {
      composer: { found: !!c.el, how: c.how, tag: c.el?.tagName?.toLowerCase() ?? null },
      sendButton: { found: !!s.el, how: s.how },
      reply: {
        found: !!r.el, how: r.how,
        chars: r.text.length,
        hasFence: r.text.includes("```"),
        blocks: (r.blocks || []).length,
        langs: [...new Set((r.blocks || []).map((b) => b.lang || "untagged"))].slice(0, 4),
        preview: r.text.slice(0, 120),
      },
      visibleEditables: editables,
      url: location.href,
    };
  }

  window.AKBSite = { findComposer, findSendButton, findLastReplyText, setComposerText, submit, diagnose, visible };
})();
