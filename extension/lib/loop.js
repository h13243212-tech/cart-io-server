/* ==================================================================
   LOOP — the pure half of the agentic loop.
   ------------------------------------------------------------------
   No DOM, no chrome APIs, nothing to mock. Everything that decides
   "should a command run, and what goes back into the chat" lives here so
   it can be tested in node. The DOM half (site.js) is the part that
   cannot be tested without a browser, so it is kept as thin as possible
   and given nothing to decide.

   HOW THE "AGENT" ACTUALLY WORKS
   Arena has no tool-calling API to hook. So the model is given a prompt
   that says: to use the VM, emit exactly one fenced bash block and stop.
   This module finds those blocks in the reply text, runs them through the
   bridge, and formats the result as a message that gets pasted back into
   the chat. The model then reads the result and continues. It is a tool
   loop simulated through the chat UI — the model never makes a tool call,
   it emits text that we interpret.
   ================================================================== */

/** Only these fence languages are executable. A ```text block is output,
 *  never a command — executing every fence would run code samples.
 *  `console` / `shellsession` are shell transcripts: models reach for them
 *  when the site renders a code block with a language chip. */
export const EXEC_LANGS = new Set([
  "sh", "bash", "zsh", "shell", "shellscript", "kali", "zos",
  "console", "shellsession", "terminal",
]);

/** Squash a language label as displayed ("Shell Session", "Bash") into a key. */
export function normaliseLang(label) {
  const squashed = String(label ?? "").trim().toLowerCase().replace(/[^a-z0-9+#.-]+/g, "");
  return squashed || "untagged";
}

export const LIMITS = {
  maxCommandChars: 4000,
  maxResultChars: 3000,
  maxSteps: 24,
};

/** Pull executable fenced blocks out of a reply, in document order. */
export function parseCommandBlocks(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  const re = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lang = (m[1] || "").toLowerCase();
    if (!EXEC_LANGS.has(lang)) continue;
    const cmd = cleanCommand(m[2]);
    if (!cmd) continue;
    if (cmd.length > LIMITS.maxCommandChars) continue;
    out.push({ lang, cmd });
  }
  return out;
}

/**
 * Models copy shell prompts from tutorials. `$ ls` is meant to be `ls`,
 * but only when EVERY line has the prompt — otherwise a `$` inside a
 * script would be mangled.
 */
export function cleanCommand(raw) {
  let cmd = String(raw ?? "");
  const lines = cmd.split("\n").filter(l => l.trim() !== "");
  if (lines.length) {
    const allPrompted = lines.every(l => /^\s*\$ /.test(l));
    if (allPrompted) cmd = cmd.replace(/^\s*\$ /gm, "");
  }
  return cmd.replace(/^\s+|\s+$/g, "");
}

/** Stable identity for a block, so the same command is not run twice
 *  while the observer keeps firing on the same DOM node. */
export function dedupeKey(cmd) {
  let h = 0;
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

/**
 * What should happen next, given the current reply text.
 * Returns a decision, never performs one — so the same function drives
 * both the live loop and the tests.
 */
/**
 * Commands as the *page* gave them to us.
 *
 * Rendered markdown keeps no backticks: a site that turns ```bash into a
 * styled code-block component leaves us with the code and a language chip,
 * so the fence parser sees nothing. These blocks are therefore preferred
 * over fence parsing whenever the DOM layer can supply them.
 */
/** A rendered block often repeats its language chip as the first code line. */
function stripChip(code, lang) {
  const lines = String(code).split("\n");
  if (lines.length < 2) return code;
  const first = normaliseLang(lines[0]);
  if (first !== "untagged" && (first === lang || EXEC_LANGS.has(first))) {
    return lines.slice(1).join("\n");
  }
  return code;
}

export function blocksToCommands(rawBlocks = []) {
  const list = Array.isArray(rawBlocks) ? rawBlocks : [];
  return list
    .map((b) => {
      const lang = normaliseLang(b?.lang);
      return { lang, cmd: cleanCommand(stripChip(b?.code ?? "", lang)) };
    })
    .filter((b) => b.cmd && b.cmd.length <= LIMITS.maxCommandChars)
    .slice(0, 8);
}

/**
 * A label we could not read is not a licence to run code: an untagged block is
 * executable only when it is the ONLY block in the reply. One bare block after
 * "run this" is the command; several bare blocks are a tutorial.
 */
export function isExecutable(block, total) {
  if (EXEC_LANGS.has(block.lang)) return true;
  return block.lang === "untagged" && total === 1;
}

export function nextAction({
  text = "", blocks: rawBlocks = [], seen = new Set(), armed = false,
  steps = 0, maxSteps = LIMITS.maxSteps,
} = {}) {
  if (!armed) return { action: "idle", saw: null };
  if (steps >= maxSteps) return { action: "stop", reason: `step budget exhausted (${maxSteps})` };

  const structural = Array.isArray(rawBlocks) && rawBlocks.length > 0;
  const candidates = structural
    ? blocksToCommands(rawBlocks)
    : parseCommandBlocks(text).map((b) => ({ lang: b.lang, cmd: b.cmd }));

  // reported back so the panel can say what it saw instead of going quiet
  const saw = candidates.length
    ? { from: structural ? "dom" : "fence", blocks: candidates.length,
        langs: [...new Set(candidates.map((b) => b.lang))].slice(0, 4) }
    : null;

  if (!candidates.length) return { action: "idle", saw };

  const runnable = candidates.filter((b) => isExecutable(b, candidates.length));
  if (!runnable.length) return { action: "idle", saw, reason: "no executable block" };

  for (const b of runnable) {
    const key = dedupeKey(b.cmd);
    if (seen.has(key)) continue;
    return { action: "run", cmd: b.cmd, key, saw };
  }
  return { action: "idle", saw, reason: "already ran this" };
}

/**
 * Format a command result as the message that goes back into the chat.
 *
 * Tag-delimited, not fenced: command output frequently contains ```
 * (READMEs, code, diffs), and an embedded fence would break parsing of
 * the very block we are replying to.
 */
export function makeResultMessage(res, opts = {}) {
  const max = opts.maxChars ?? LIMITS.maxResultChars;
  const code = res?.code;
  const ms = res?.ms;
  const bits = [`exit=${code === null || code === undefined ? "?" : code}`];
  if (res?.timedOut) bits.unshift("TIMED OUT");
  if (typeof ms === "number") bits.push(`${ms}ms`);

  let body = "";
  const out = String(res?.out ?? "");
  const err = String(res?.err ?? "");
  if (out.trim()) body += out.replace(/\s+$/, "");
  if (err.trim()) body += (body ? "\n" : "") + "--- stderr ---\n" + err.replace(/\s+$/, "");
  if (!body) body = "(no output)";

  if (body.length > max) body = body.slice(0, max) + `\n…[truncated, ${body.length - max} more characters]`;

  // never let output forge our own delimiters
  body = body.replace(/\[\/?bridge\b/gi, m => m.replace("[", "[ "));

  return `[bridge ${bits.join(" ")}]\n${body}\n[/bridge]`;
}

/** Human-readable one-liner for the panel log. */
export function summariseCommand(cmd) {
  const one = String(cmd).split("\n")[0].trim();
  return one.length > 90 ? one.slice(0, 90) + "…" : one;
}
