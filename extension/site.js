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

  // innerText respects layout (and is what a human sees); textContent always
  // exists. jsdom, some shadow roots and some SVG nodes only have the latter.
  const textOf = el => (el?.innerText ?? el?.textContent ?? "");

  const area = el => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };

  /** The chat input box. Override wins; otherwise biggest editable thing
   *  nearest the bottom of the viewport. */
  /* ==================================================================
     arena.ai — the one site we have real DOM facts for.

     These selectors and behaviours were validated live against
     arena.ai/text/direct by the ZeroScript project (GPL-3.0). We take the
     FACTS — which element is what — and implement them ourselves:

       <ol class="... flex-col-reverse">          the message list
         direct child <div class="mx-auto ...">   one turn
           <div class="prose">                    the markdown body
         a user turn carries `justify-end`; an assistant turn does not
         fenced code = <div class="not-prose"><pre>...</pre></div>
       composer    = the only <textarea> inside a <form>
       send button = aria-label "Send message"

     THE CRITICAL ONE: flex-col-reverse means the DOM order is NEWEST FIRST.
     Reading "the last matching element on the page" therefore returns the
     OLDEST message — which never changes, so the loop looked asleep. That
     single fact is why every earlier attempt failed on this site.
     ================================================================== */
  const ARENA = {
    host: /(^|\.)arena\.ai$/i,
    list: "ol.flex-col-reverse",
    body: ".prose",
    userClass: "justify-end",
    sendAria: /send message|envoyer/i,
  };

  const isArena = () => ARENA.host.test(location.hostname);

  function arenaList() {
    return document.querySelector(ARENA.list)
      || [...document.querySelectorAll("ol")].find((o) => o.querySelector(ARENA.body))
      || null;
  }

  /** Turns in DOM order — which on arena means newest first. */
  function arenaTurns() {
    const ol = arenaList();
    if (!ol) return [];
    return [...ol.children].filter((c) =>
      c.tagName === "DIV"
      && (c.classList.contains("mx-auto") || c.querySelector('[role="region"][aria-roledescription="carousel"]'))
      && c.querySelector(ARENA.body));
  }

  /** The most recent assistant turn (first in DOM order, because of reverse). */
  function arenaNewestReply() {
    const turns = arenaTurns();
    for (const t of turns) {
      if (!t.classList.contains(ARENA.userClass)) return t;
    }
    return null;
  }

  function findComposer(override) {
    if (override) {
      const el = document.querySelector(override);
      if (el) return { el, how: "override" };
    }
    // arena: the composer is the only <textarea> inside a <form>
    // (the others are recaptcha / aria-hidden)
    const formArea = [...document.querySelectorAll("form textarea")]
      .filter((e) => visible(e) && e.getAttribute("aria-hidden") !== "true");
    if (formArea.length) return { el: formArea[formArea.length - 1], how: "form textarea" };

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
  const b_disabled = (b) => !!b && (b.disabled || b.getAttribute("aria-disabled") === "true");

  function findSendButton(composer, override) {
    if (override) {
      const el = document.querySelector(override);
      if (el) return { el, how: "override" };
    }
    // arena (and most React chat UIs): one button named "Send message"
    const named = [...document.querySelectorAll("button[aria-label]")]
      .filter(visible)
      .find((b) => ARENA.sendAria.test(b.getAttribute("aria-label") || ""));
    if (named && !b_disabled(named)) return { el: named, how: "aria-label send" };

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

    // <pre> is the normal case. Some renderers skip it, so fall back to a
    // <code> with newlines, then to a div whose class says "code".
    let blocks = [...root.querySelectorAll("pre")];
    if (!blocks.length) {
      blocks = [...root.querySelectorAll("code")].filter((c) => (c.innerText || "").includes("\n"));
    }
    if (!blocks.length) {
      blocks = [...root.querySelectorAll('[class*="code" i], [class*="highlight" i]')]
        .filter((n) => !n.querySelector("pre, code") && (n.innerText || "").includes("\n"))
        .slice(-3);
    }

    for (const pre of blocks) {
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

  /**
   * The last rendered code block on the page, ignoring our own panel.
   *
   * This is the detection that does not care what the chat UI looks like:
   * message containers differ per site, get renamed, and are re-rendered —
   * but a command always ends up in <pre>/<code>. Reading that is far more
   * durable than guessing which div holds "the assistant's reply".
   */
  function lastCodeBlock(exclude) {
    // arena: only the newest reply's blocks count — never the conversation's
    // history, and never the oldest turn by accident.
    if (isArena()) {
      const turn = arenaNewestReply();
      const scope = turn && (turn.querySelector(ARENA.body) || turn);
      if (scope) {
        const found = codeBlocksIn(scope);
        if (found.length) {
          const b = found[found.length - 1];
          return { el: scope, lang: b.lang, code: (b.code || "").trim() };
        }
        return null;
      }
    }
    const inPanel = (n) => (exclude && (exclude === n || exclude.contains(n)))
      || (n.closest && n.closest("#akb-panel"));
    const all = [...document.querySelectorAll("pre, code")].filter((n) => {
      if (inPanel(n)) return false;
      return (n.innerText || n.textContent || "").trim().length > 0;
    });
    const pres = all.filter((n) => n.tagName === "PRE");
    const pool = pres.length ? pres : all;      // a <code> inside a <pre> would duplicate
    const el = pool[pool.length - 1];
    if (!el) return null;

    const codeEl = el.querySelector?.("code") || el;
    let code = codeEl.innerText || codeEl.textContent || "";
    const lang = langOf(el, codeEl, code);
    const first = code.split("\n")[0].trim().toLowerCase();
    if (code.split("\n").length > 1 && LANG_LABELS.has(first)) {
      code = code.split("\n").slice(1).join("\n");   // a chip rendered inside the block
    }
    return { el, lang, code: code.trim() };
  }

  function findLastReplyText(override) {
    // arena: the newest assistant turn, NOT the last matching node in the
    // document (the list is flex-col-reverse, so the last node is the oldest).
    if (!override && isArena()) {
      const turn = arenaNewestReply();
      if (turn) {
        const slide = turn.querySelector('[aria-roledescription="slide"]');
        const body = (slide && slide.querySelector(ARENA.body)) || turn.querySelector(ARENA.body) || turn;
        return { el: body, text: textOf(body).trim(), blocks: codeBlocksIn(body), how: "arena-turn" };
      }
    }
    if (override) {
      const nodes = [...document.querySelectorAll(override)];
      if (nodes.length) {
        const el = nodes[nodes.length - 1];
        return { el, text: textOf(el), blocks: codeBlocksIn(el), how: "override" };
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
        const text = textOf(nodes[i]).trim();
        if (text.length > 0) return { el: nodes[i], text, blocks: codeBlocksIn(nodes[i]), how };
      }
    }
    return { el: null, text: "", blocks: [], how: "none" };
  }

  /** Type into the chat box in a way React/Lexical editors actually see. */
  function setComposerText(el, text) {
    if (!el) return false;
    el.focus();

    // arena's composer is a React-controlled <textarea>: assigning .value
    // directly leaves React's state stale and the send button disabled. Set it
    // through the native prototype setter, then fire input.
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      try {
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, text); else el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return (el.value || "").includes(text.slice(0, 40));
      } catch { /* fall through to the generic path */ }
    }

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
        presOnPage: document.querySelectorAll("pre").length,
        langs: [...new Set((r.blocks || []).map((b) => b.lang || "untagged"))].slice(0, 4),
        preview: r.text.slice(0, 120),
      },
      visibleEditables: editables,
      url: location.href,
    };
  }

  window.AKBSite = { findComposer, findSendButton, findLastReplyText, lastCodeBlock, setComposerText, submit, diagnose, visible };
})();
