/* ==================================================================
   PROTOCOL UNIT TESTS — the parsing that every byte off the wire goes
   through. Pure functions, so this is cheap and fast, and it covers the
   failure mode that streaming code always has: chunks that land on a
   boundary.
   ================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import {
  splitNdjson, normalizeExec, isTrustedMessage, describeHealth, eventToRow, LIMITS,
} from "../extension/lib/protocol.js";

test("splitNdjson reassembles events across arbitrary chunk boundaries", () => {
  const stream =
    '{"t":"start","cmd":"ls"}\n' +
    '{"t":"out","d":"a.txt\\n"}\n' +
    '{"t":"out","d":"b.txt\\n"}\n' +
    '{"t":"exit","code":0,"ms":12}\n';

  // Feed the same stream one byte at a time: every possible split happens.
  let buf = "";
  const seen = [];
  for (const ch of stream) {
    buf += ch;
    const { events, rest } = splitNdjson(buf);
    seen.push(...events);
    buf = rest;
  }
  assert.equal(buf, "", "nothing should be left over");
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.map(e => e.t), ["start", "out", "out", "exit"]);
  assert.equal(seen[1].d, "a.txt\n");
  assert.equal(seen[3].code, 0);
});

test("splitNdjson keeps a partial line for the next chunk", () => {
  const a = splitNdjson('{"t":"out","d":"hel');
  assert.equal(a.events.length, 0);
  assert.equal(a.rest, '{"t":"out","d":"hel');

  const b = splitNdjson(a.rest + 'lo"}\n');
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].d, "hello");
  assert.equal(b.rest, "");
});

test("splitNdjson survives malformed and blank lines", () => {
  const { events } = splitNdjson('not json\n\n{"t":"out","d":"ok"}\n{"broken":\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].d, "ok");
});

test("splitNdjson drops a runaway buffer instead of growing forever", () => {
  const { events, rest } = splitNdjson("x".repeat(1_000_001));
  assert.equal(events.length, 0);
  assert.equal(rest, "");
});

test("splitNdjson ignores JSON that is not an object", () => {
  const { events } = splitNdjson('42\n"str"\nnull\n[1,2]\n{"t":"out"}\n');
  // only the object survives; arrays are objects but carry no event shape,
  // so this asserts we never crash on them either way
  assert.ok(events.every(e => typeof e === "object" && e !== null));
  assert.ok(events.some(e => e.t === "out"));
});

test("normalizeExec validates and clamps", () => {
  assert.equal(normalizeExec({ cmd: "ls" }).ok, true);
  assert.equal(normalizeExec({ cmd: "  " }).ok, false);
  assert.equal(normalizeExec({ cmd: 42 }).ok, false);
  assert.equal(normalizeExec(null).ok, false);
  assert.equal(normalizeExec({ cmd: "x".repeat(LIMITS.maxCmdChars + 1) }).ok, false);

  const dflt = normalizeExec({ cmd: "ls" });
  assert.equal(dflt.timeout_s, LIMITS.defaultTimeout);

  assert.equal(normalizeExec({ cmd: "ls", timeout_s: 0 }).timeout_s, LIMITS.minTimeout);
  assert.equal(normalizeExec({ cmd: "ls", timeout_s: 1e9 }).timeout_s, LIMITS.maxTimeout);
  assert.equal(normalizeExec({ cmd: "ls", timeout_s: "abc" }).timeout_s, LIMITS.defaultTimeout);
  // Number("") is 0, not NaN — must clamp to the floor, not silently pass through
  assert.equal(normalizeExec({ cmd: "ls", timeout_s: "" }).timeout_s, LIMITS.minTimeout);
});

test("isTrustedMessage rejects cross-origin and cross-window posts", () => {
  const self = { location: { origin: "https://arena.ai" }, name: "self" };
  const win = self;

  assert.equal(isTrustedMessage({ source: win, origin: "https://arena.ai" }, self), true);
  assert.equal(isTrustedMessage({ source: win, origin: "https://evil.example" }, self), false);
  assert.equal(isTrustedMessage({ source: {}, origin: "https://arena.ai" }, self), false);
  assert.equal(isTrustedMessage(null, self), false);
  assert.equal(isTrustedMessage({ source: win, origin: "https://arena.ai" }, null), false);
});

test("describeHealth handles every state the VM can be in", () => {
  assert.equal(describeHealth({ ok: true, user: "kali", host: "vm", agent: "0.1.0", uptime_s: 5 }).up, true);
  assert.equal(describeHealth({ ok: false, error: "offline" }).up, false);
  assert.equal(describeHealth(null).up, false);
  assert.match(describeHealth({ ok: true, user: "kali", host: "vm" }).label, /kali@vm/);
});

test("eventToRow never emits markup and labels failures honestly", () => {
  assert.equal(eventToRow({ t: "out", d: "<img src=x onerror=alert(1)>" }).text,
    "<img src=x onerror=alert(1)>");
  assert.equal(eventToRow({ t: "out", d: "<b>" }).cls, "out");
  assert.equal(eventToRow({ t: "exit", code: 0 }).cls, "meta");
  assert.equal(eventToRow({ t: "exit", code: 1 }).cls, "err");
  assert.match(eventToRow({ t: "exit", code: null, timedOut: true }).text, /timed out/);
  assert.match(eventToRow({ t: "exit", code: -9, killed: true }).text, /killed/);
  assert.equal(eventToRow({ t: "nonsense" }), null);
});
