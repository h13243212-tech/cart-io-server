/* ==================================================================
   AGENT TESTS — real HTTP against the real Python agent.
   The /run endpoint is what the loop calls, so its contract is what these
   pin down: one JSON object, honest exit code, separate streams, timeout
   that actually kills, output that cannot flood the chat context.
   ================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, "..", "agent", "bridge_agent.py");
const TOKEN = "test-" + Math.random().toString(36).slice(2).padEnd(36, "x");

async function startAgent(extra = []) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const tokenFile = path.join(os.tmpdir(), `akb-${process.pid}-${port}.tok`);
  const proc = spawn("python3", [AGENT, "--port", String(port), "--token", TOKEN,
    "--token-file", tokenFile, ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", d => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + "/health", { headers: { authorization: "Bearer " + TOKEN } });
      if (r.ok) return { base, cleanup: () => { proc.kill("SIGKILL"); fs.rmSync(tokenFile, { force: true }); } };
    } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 80));
  }
  proc.kill("SIGKILL");
  throw new Error("agent did not start:\n" + stderr);
}

const run = async (base, cmd, opts = {}) => {
  const res = await fetch(base + "/run", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + (opts.token ?? TOKEN) },
    body: JSON.stringify({ cmd, timeout_s: opts.timeout_s, cap: opts.cap }),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};

test("agent /run", async (t) => {
  const a = await startAgent();
  t.after(a.cleanup);

  await t.test("requires the token", async () => {
    const res = await fetch(a.base + "/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "id" }),
    });
    assert.equal(res.status, 401);
  });

  await t.test("returns one JSON object with exit code and both streams", async () => {
    const { status, body } = await run(a.base, "echo hello; echo oops >&2; exit 3");
    assert.equal(status, 200);
    assert.equal(body.code, 3);
    assert.equal(body.out, "hello\n");
    assert.equal(body.err, "oops\n");
    assert.equal(body.timedOut, false);
    assert.equal(typeof body.ms, "number");
    assert.equal(body.truncated, false);
  });

  await t.test("keeps stdout and stderr apart", async () => {
    const { body } = await run(a.base, "printf A; printf B >&2");
    assert.equal(body.out, "A");
    assert.equal(body.err, "B");
  });

  await t.test("kills a command that overruns its timeout", async () => {
    const started = Date.now();
    const { body } = await run(a.base, "sleep 30", { timeout_s: 1 });
    assert.equal(body.timedOut, true);
    assert.ok(Date.now() - started < 8000, "the timeout did not fire promptly");
  });

  await t.test("kills the whole process group, not just bash", async () => {
    const started = Date.now();
    const { body } = await run(a.base, "bash -c 'sleep 30 & sleep 30'", { timeout_s: 1 });
    assert.equal(body.timedOut, true);
    assert.ok(Date.now() - started < 8000, "a child kept the pipes open");
  });

  await t.test("caps output so a noisy command cannot flood the chat", async () => {
    const { body } = await run(a.base, "head -c 20000 /dev/zero | tr '\\0' 'x'", { cap: 500 });
    assert.equal(body.truncated, true);
    assert.ok(body.out.length < 700, `expected <= ~500 chars, got ${body.out.length}`);
    assert.match(body.out, /truncated/);
  });

  await t.test("rejects junk instead of running it", async () => {
    assert.equal((await run(a.base, "")).status, 400);
    assert.equal((await run(a.base, "   ")).status, 400);
    assert.equal((await run(a.base, "x".repeat(9000))).status, 413);
  });

  await t.test("a failing command is reported, not thrown", async () => {
    const { status, body } = await run(a.base, "this-command-does-not-exist-akb");
    assert.equal(status, 200);
    assert.notEqual(body.code, 0);
    assert.match(body.err, /not found|No such file/i);
  });

  await t.test("streaming /exec still works alongside /run", async () => {
    const res = await fetch(a.base + "/exec", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ cmd: "echo streamed" }),
    });
    const text = await res.text();
    const events = text.trim().split("\n").map(l => JSON.parse(l));
    assert.equal(events[0].t, "start");
    assert.ok(events.some(e => e.t === "out" && /streamed/.test(e.d)));
    assert.equal(events.at(-1).t, "exit");
  });
});

test("agent --deny-rm seatbelt applies to /run too", async (t) => {
  const a = await startAgent(["--deny-rm"]);
  t.after(a.cleanup);
  const { status } = await run(a.base, "rm -rf / --no-preserve-root");
  assert.equal(status, 403);
  // and it does not block normal work
  const ok = await run(a.base, "echo fine");
  assert.equal(ok.body.out, "fine\n");
});
