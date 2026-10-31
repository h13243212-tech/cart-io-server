/* ==================================================================
   DOM TESTS — the layer that could not be tested from a terminal, now
   tested from a terminal.

   site.js is a browser script, but a JSDOM window is close enough to prove
   the two things that kept failing on the live site: reading a command out
   of a rendered code block, and finding the chat input box.

   jsdom is a dev dependency. Without it these tests skip rather than fail:
   `npm install` once, and they run.
   ================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SITE_JS = fs.readFileSync(path.join(ROOT, "extension", "site.js"), "utf8");
const DEMO = fs.readFileSync(path.join(ROOT, "kali", "demo.html"), "utf8");

let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  /* not installed — the tests below skip */
}
const need = JSDOM ? false : "jsdom not installed (run: npm install)";

/** A minimal page (no demo chat) with site.js evaluated inside it. */
function bare(html, { layout = true } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, { runScripts: "dangerously" });
  const w = dom.window;
  if (layout) {
    w.Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 600, top: 600, left: 0, width: 600, height: 44, right: 600, bottom: 644, toJSON() {} };
    };
  }
  w.eval(SITE_JS);
  return w;
}

/** A demo page with extra markup appended, plus site.js evaluated inside it. */
function page(extra = "", { layout = true } = {}) {
  const dom = new JSDOM(DEMO.replace("</body>", extra + "</body>"), { runScripts: "dangerously" });
  const w = dom.window;
  if (layout) {
    // jsdom has no layout engine: every element measures 0x0, which makes
    // visible() false and every position-based heuristic tie. Give everything
    // a believable box so the code under test sees what a browser would.
    w.Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 600, top: 600, left: 0, width: 600, height: 44, right: 600, bottom: 644, toJSON() {} };
    };
  }
  w.eval(SITE_JS);
  return w;
}

/** The shape arena.ai actually renders: language chip in a header, code in <pre><code>. */
const ARENA_BLOCK = `
  <div data-message-author-role="assistant"><div class="markdown-body">
    <p>Let me check the system to confirm.</p>
    <div class="rounded-md border">
      <div class="flex"><div class="text-xs">Bash</div><button>Copy</button></div>
      <pre><code>cat /etc/os-release &amp;&amp; uname -a</code></pre>
    </div>
  </div></div>`;

test("reading a command out of a rendered page", { skip: need }, async (t) => {
  await t.test("aquires the block, its language and its text", () => {
    const w = page(ARENA_BLOCK);
    const b = w.AKBSite.lastCodeBlock(null);
    assert.ok(b, "no block found");
    assert.equal(b.lang, "bash", "the chip in the header is the language");
    assert.equal(b.code, "cat /etc/os-release && uname -a");
  });

  await t.test("finds the block the demo page renders", () => {
    const w = page(`<div class="msg assistant"><div class="body">
      <div class="code"><div class="code-head"><span class="lang">Bash</span></div>
      <pre><code class="language-bash">curl -s ifconfig.me</code></pre></div></div></div>`);
    const b = w.AKBSite.lastCodeBlock(null);
    assert.equal(b.lang, "bash");
    assert.equal(b.code, "curl -s ifconfig.me");
  });

  await t.test("a block with no language is still a block", () => {
    const b = page(`<div><pre><code>hostname; id -un</code></pre></div>`).AKBSite.lastCodeBlock(null);
    assert.equal(b.lang, "");
    assert.equal(b.code, "hostname; id -un");
  });

  await t.test("inline code in the prose does not win over the block", () => {
    const b = page(`<p>try <code>ls -la</code> yourself</p>
      <div class="code"><div class="code-head"><span class="lang">Bash</span></div>
      <pre><code>hostname</code></pre></div>`).AKBSite.lastCodeBlock(null);
    assert.equal(b.code, "hostname");
  });

  await t.test("never picks up its own panel", () => {
    const w = page(`<div id="akb-panel"><pre><code>a result we typed</code></pre></div>
      <div class="code"><div class="code-head"><span class="lang">Bash</span></div>
      <pre><code>id</code></pre></div>`);
    const b = w.AKBSite.lastCodeBlock(w.document.getElementById("akb-panel"));
    assert.equal(b.code, "id");
  });
});

test("finding the chat input", { skip: need }, async (t) => {
  await t.test("finds the demo page's composer", () => {
    const c = page().AKBSite.findComposer("");
    assert.ok(c.el, "composer not found");
    assert.equal(c.how, "role=textbox");
  });

  await t.test("finds a plain textarea when that is all there is", () => {
    const c = bare(`<textarea id="real"></textarea>`).AKBSite.findComposer("");
    assert.equal(c.el.id, "real");
    assert.equal(c.how, "textarea");
  });

  await t.test("an override selector wins", () => {
    const w = bare(`<div id="mine" contenteditable="true"></div>`);
    const c = w.AKBSite.findComposer("#mine");
    assert.equal(c.el.id, "mine");
    assert.equal(c.how, "override");
  });
});

test("diagnose tells the truth about the page", { skip: need }, async (t) => {
  await t.test("reports the block it can see", () => {
    const d = page(ARENA_BLOCK).AKBSite.diagnose({});
    assert.equal(d.reply.blocks, 1);
    // the array is built inside the JSDOM realm, so compare its contents
    assert.equal([...d.reply.langs].join(","), "bash");
    assert.equal(d.composer.found, true);
    assert.ok(d.reply.presOnPage >= 1);
  });

  await t.test("reports zero blocks on a page without code", () => {
    const d = page(`<p>no code anywhere</p>`).AKBSite.diagnose({});
    assert.equal(d.reply.blocks, 0);
  });
});

/* ==================================================================
   arena.ai — built from the DOM facts the ZeroScript project validated
   live (GPL-3.0; we take the facts, not their code).

   The one that matters: the message list is `ol.flex-col-reverse`, so the
   DOM order is NEWEST FIRST. Every earlier version of this extension took
   "the last matching element on the page" — which on arena is the OLDEST
   message, a node that never changes. The loop therefore looked asleep
   while the model was happily emitting commands.
   ================================================================== */
const ARENA_PAGE = `<!DOCTYPE html><html><body>
  <form>
    <textarea placeholder="Ask anything…"></textarea>
    <button aria-label="Send message">↑</button>
    <button aria-label="Stop generation" style="display:none">■</button>
  </form>
  <ol class="flex flex-col-reverse gap-4">
    <!-- newest assistant turn is FIRST in the DOM -->
    <div class="mx-auto max-w-[800px]"><div class="flex flex-col gap-3">
      <div class="prose"><p>Running it now:</p>
        <div class="not-prose"><pre><code class="language-bash">curl -s ifconfig.me</code></pre></div>
      </div>
    </div></div>
    <div class="mx-auto max-w-[800px] justify-end"><div class="prose">what is my public ip</div></div>
    <!-- oldest assistant turn is LAST in the DOM -->
    <div class="mx-auto max-w-[800px]"><div class="prose"><p>READY</p></div></div>
    <div class="h-0"></div>
  </ol>
</body></html>`;

function arena(markup = ARENA_PAGE) {
  const dom = new JSDOM(markup, { runScripts: "dangerously", url: "https://arena.ai/c/abc-123" });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = () => ({
    x: 0, y: 600, top: 600, left: 0, width: 600, height: 44, right: 600, bottom: 644, toJSON() {},
  });
  w.eval(SITE_JS);
  return w;
}

test("arena.ai: reads the newest reply, not the oldest", { skip: need }, async (t) => {
  await t.test("the DOM order is newest-first and we respect it", () => {
    const r = arena().AKBSite.findLastReplyText();
    assert.equal(r.how, "arena-turn");
    assert.match(r.text, /Running it now/);
    assert.doesNotMatch(r.text, /READY/, "picked the oldest turn — the flex-col-reverse trap");
  });

  await t.test("the command comes from that reply", () => {
    const b = arena().AKBSite.lastCodeBlock(null);
    assert.equal(b.lang, "bash");
    assert.equal(b.code, "curl -s ifconfig.me");
  });

  await t.test("a brand new reply wins over a long history", () => {
    const html = ARENA_PAGE.replace("<ol", `
      <ol`)
      .replace("<!-- newest assistant turn is FIRST in the DOM -->",
        `<div class="mx-auto max-w-[800px]"><div class="prose"><p>ok</p>
           <div class="not-prose"><pre><code class="language-bash">hostname; id -un</code></pre></div>
         </div></div>`);
    const b = arena(html).AKBSite.lastCodeBlock(null);
    assert.equal(b.code, "hostname; id -un");
  });

  await t.test("nothing to run returns null, not the previous command", () => {
    const html = ARENA_PAGE.replace(
      /<div class="not-prose">[\s\S]*?<\/div>/,
      "");
    const b = arena(html).AKBSite.lastCodeBlock(null);
    assert.equal(b, null);
  });
});

test("arena.ai: composer, send button, and typing", { skip: need }, async (t) => {
  await t.test("the composer is the form's textarea", () => {
    const c = arena().AKBSite.findComposer("");
    assert.ok(c.el);
    assert.equal(c.el.tagName, "TEXTAREA");
    assert.equal(c.how, "form textarea");
  });

  await t.test("the send button is found by its aria-label, and only when enabled", () => {
    const w = arena();
    const c = w.AKBSite.findComposer("");
    const s = w.AKBSite.findSendButton(c.el);
    assert.equal(s.how, "aria-label send");
    assert.equal(s.el.getAttribute("aria-label"), "Send message");
  });

  await t.test("typing drives a React-controlled textarea", () => {
    const w = arena();
    const c = w.AKBSite.findComposer("");
    let inputFired = false;
    c.el.addEventListener("input", () => { inputFired = true; });
    assert.equal(w.AKBSite.setComposerText(c.el, "hello VM"), true);
    assert.equal(c.el.value, "hello VM");
    assert.equal(inputFired, true, "React only notices an input event");
  });

  await t.test("the whole conversation is NOT read as one turn", () => {
    const w = arena();
    const turns = w.document.querySelectorAll("ol.flex-col-reverse > div.mx-auto");
    assert.equal(turns.length, 3);
    assert.equal(w.AKBSite.findLastReplyText().text.includes("what is my public ip"), false,
      "the user's own message must never be read as the reply");
  });
});
