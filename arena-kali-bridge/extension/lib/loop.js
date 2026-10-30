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
 *  never a command — executing every fence would run code samples. */
export const EXEC_LANGS = new Set(["sh", "bash", "zsh", "shell", "kali", "zos"]);

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
export function nextAction({ text, seen = new Set(), armed = false, steps = 0, maxSteps = LIMITS.maxSteps }) {
  if (!armed) return { action: "idle" };
  if (steps >= maxSteps) return { action: "stop", reason: `step budget exhausted (${maxSteps})` };

  const blocks = parseCommandBlocks(text);
  if (!blocks.length) return { action: "idle" };

  for (const b of blocks) {
    const key = dedupeKey(b.cmd);
    if (seen.has(key)) continue;
    return { action: "run", cmd: b.cmd, key };
  }
  return { action: "idle" };
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
