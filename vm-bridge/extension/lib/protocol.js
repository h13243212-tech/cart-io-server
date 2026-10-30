/* ==================================================================
   PROTOCOL — pure helpers shared by the service worker and the tests.
   ------------------------------------------------------------------
   Deliberately dependency-free and DOM-free so `node --test` can exercise
   it directly. Everything the bridge parses off the wire goes through
   here, which means there is exactly one place that can be wrong.
   ================================================================== */

export const LIMITS = {
  maxCmdChars: 8000,
  minTimeout: 1,
  maxTimeout: 900,
  defaultTimeout: 120,
};

/**
 * Split a growing buffer into complete newline-delimited JSON events,
 * returning any trailing partial line for the next chunk.
 *
 * This is the part of streaming code that is always wrong the first time:
 * a network chunk lands wherever it lands, so an event can be cut in half
 * across two reads. Splitting on "\n" only at the end of each chunk works
 * until it doesn't.
 */
export function splitNdjson(buffer) {
  const events = [];
  let rest = buffer;
  let nl;
  while ((nl = rest.indexOf("\n")) >= 0) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") events.push(parsed);
    } catch {
      // A malformed line is skipped, not fatal: one bad event must not
      // kill an otherwise healthy stream.
    }
  }
  // Hard cap so a peer that never sends a newline cannot grow the buffer
  // until the worker dies.
  if (rest.length > 1_000_000) rest = "";
  return { events, rest };
}

/** Validate and clamp an exec request coming from the page or the UI. */
export function normalizeExec(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "expected an object" };

  const cmd = typeof input.cmd === "string" ? input.cmd : "";
  if (!cmd.trim()) return { ok: false, error: "cmd must be a non-empty string" };
  if (cmd.length > LIMITS.maxCmdChars) {
    return { ok: false, error: `cmd too long (max ${LIMITS.maxCmdChars} characters)` };
  }

  let timeout = Number(input.timeout_s);
  if (!Number.isFinite(timeout)) timeout = LIMITS.defaultTimeout;
  timeout = Math.max(LIMITS.minTimeout, Math.min(LIMITS.maxTimeout, timeout));

  return { ok: true, cmd, timeout_s: timeout };
}

/**
 * The page API must only accept messages from its own window and origin.
 * Without this check any iframe or third-party script on the page could
 * drive the bridge.
 */
export function isTrustedMessage(event, self) {
  if (!event || !self) return false;
  if (event.source !== self) return false;
  if (event.origin !== self.location.origin) return false;
  return true;
}

/** Only worth rendering to the user as a status line. */
export function describeHealth(h) {
  if (!h || h.ok !== true) return { up: false, label: h?.error ? String(h.error) : "offline" };
  return {
    up: true,
    label: `${h.user ?? "?"}@${h.host ?? "?"}`,
    detail: `agent ${h.agent ?? "?"} · up ${h.uptime_s ?? 0}s`,
  };
}

/** Turn an event into one displayable row. Never returns HTML. */
export function eventToRow(ev) {
  switch (ev?.t) {
    case "start":   return { cls: "meta", text: `$ ${ev.cmd}` };
    case "out":     return { cls: "out", text: String(ev.d ?? "") };
    case "err":     return { cls: "err", text: String(ev.d ?? "") };
    case "truncated": return { cls: "meta", text: `[output truncated: ${ev.stream}]` };
    case "error":   return { cls: "err", text: `error: ${ev.message ?? "unknown"}` };
    case "exit": {
      const bits = [];
      if (ev.timedOut) bits.push("timed out");
      else if (ev.killed) bits.push("killed");
      bits.push(ev.code === null ? "no exit code" : `exit ${ev.code}`);
      if (typeof ev.ms === "number") bits.push(`${ev.ms}ms`);
      return { cls: ev.code === 0 || ev.timedOut ? "meta" : "err", text: `[${bits.join(" · ")}]` };
    }
    default: return null;
  }
}
