/* ==================================================================
   AGENT INTEGRATION TESTS
   ------------------------------------------------------------------
   These spawn the real Python agent and talk to it over real HTTP. No
   mocks: the things being checked (chunked streaming, token auth,
   process-group kills, output ceilings) only fail in ways a mock cannot
   reproduce.

   The agent executes shell commands, so every guard it has is tested
   here rather than assumed.

   Run: node --test test/agent.test.mjs
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
const TOKEN = "test-token-" + Math.random().toString(36).slice(2).padEnd(32, "x");

async function startAgent(extraArgs = []) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const tokenFile = path.join(os.tmpdir(), `bridge-test-${process.pid}-${port}.tok`);
  const proc = spawn("python3", [
    AGENT, "--port", String(port), "--token", TOKEN, "--token-file", tokenFile,
    ...extraArgs,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  proc.stderr.on("data", d => { stderr += d; });
  proc.on("error", () => {});

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + "/health", { headers: { authorization: "Bearer " + TOKEN } });
      if (r.ok) return { base, proc, cleanup: () => { proc.kill("SIGKILL"); fs.rmSync(tokenFile, { force: true }); } };
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 80));
  }
  proc.kill("SIGKILL");
  throw new Error("agent never came up. stderr:\n" + stderr);
}

/** POST /exec and collect every ndjson event, with arrival timestamps. */
async function exec(base, cmd, opts = {}) {
  const res = await fetch(base + "/exec", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + (opts.token ?? TOKEN) },
    body: JSON.stringify({ cmd, timeout_s: opts.timeout_s }),
  });
  if (!res.ok) {
    return { status: res.status, body: await res.json(), events: [] };
  }
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) events.push({ at: Date.now(), ...JSON.parse(line) });
    }
  }
  return { status: res.status, events };
}

const text = (events, t) => events.filter(e => e.t === t).map(e => e.d).join("");

test("agent", async (t) => {
  const agent = await startAgent();
  t.after(agent.cleanup);

  await t.test("refuses requests without the token", async () => {
    const res = await fetch(agent.base + "/health");
    assert.equal(res.status, 401);
    const exec2 = await fetch(agent.base + "/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "id" }),
    });
    assert.equal(exec2.status, 401, "unauthenticated exec must not run");
  });

  await t.test("refuses a wrong token", async () => {
    const res = await fetch(agent.base + "/health", { headers: { authorization: "Bearer nope" } });
    assert.equal(res.status, 401);
  });

  await t.test("reports health", async () => {
    const res = await fetch(agent.base + "/health", { headers: { authorization: "Bearer " + TOKEN } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.host && body.user);
  });

  await t.test("streams stdout, stderr and the exit code separately", async () => {
    const { events } = await exec(agent.base, "echo out-line; echo err-line >&2; exit 7");
    assert.equal(events[0].t, "start");
    assert.match(text(events, "out"), /out-line/);
    assert.match(text(events, "err"), /err-line/);
    assert.ok(!text(events, "out").includes("err-line"), "stderr leaked into stdout");
    const exit = events.find(e => e.t === "exit");
    assert.equal(exit.code, 7);
    assert.equal(exit.timedOut, false);
    assert.equal(events.at(-1).t, "exit", "exit must be the final event");
  });

  await t.test("streams as output arrives instead of buffering to the end", async () => {
    // 1.2s of output; a buffering implementation would deliver everything at once.
    const { events } = await exec(agent.base, "for i in 1 2 3 4; do echo tick$i; sleep 0.3; done");
    const outs = events.filter(e => e.t === "out");
    assert.ok(outs.length >= 2, `expected incremental chunks, got ${outs.length}`);
    const spread = outs.at(-1).at - outs[0].at;
    assert.ok(spread > 400, `output arrived all at once (spread ${spread}ms)`);
    assert.match(text(events, "out"), /tick4/);
  });

  await t.test("kills a command that exceeds its timeout", async () => {
    const started = Date.now();
    const { events } = await exec(agent.base, "sleep 30", { timeout_s: 1 });
    const elapsed = Date.now() - started;
    const exit = events.find(e => e.t === "exit");
    assert.ok(exit, "no exit event after timeout");
    assert.equal(exit.timedOut, true);
    assert.ok(elapsed < 8000, `timeout took ${elapsed}ms — the kill did not work`);
  });

  await t.test("kills the whole process group, not just the shell", async () => {
    // `sleep` is a child of bash; if only bash is killed, sleep survives and
    // keeps the pipes open. A short timeout plus a prompt exit proves the tree died.
    const { events } = await exec(agent.base, "bash -c 'sleep 30 & sleep 30'", { timeout_s: 1 });
    assert.ok(events.find(e => e.t === "exit")?.timedOut);
  });

  await t.test("rejects an empty command", async () => {
    const res = await fetch(agent.base + "/exec", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ cmd: "   " }),
    });
    assert.equal(res.status, 400);
  });

  await t.test("rejects malformed json", async () => {
    const res = await fetch(agent.base + "/exec", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      body: "{nope",
    });
    assert.equal(res.status, 400);
  });

  await t.test("rejects an oversized command", async () => {
    const res = await fetch(agent.base + "/exec", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ cmd: "echo " + "A".repeat(20000) }),
    });
    assert.ok(res.status === 413 || res.status === 400, `got ${res.status}`);
  });

  await t.test("answers a CORS preflight for an extension origin", async () => {
    const res = await fetch(agent.base + "/exec", {
      method: "OPTIONS",
      headers: {
        origin: "chrome-extension://abcdefghijklmnop",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnop");
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /authorization/i);
  });

  await t.test("does not hand CORS to an arbitrary website origin", async () => {
    const res = await fetch(agent.base + "/health", {
      headers: { origin: "https://evil.example", authorization: "Bearer " + TOKEN },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null,
      "a random origin must not be allowed to read responses");
  });
});

test("agent --deny-rm seatbelt", async (t) => {
  const agent = await startAgent(["--deny-rm"]);
  t.after(agent.cleanup);

  await t.test("refuses the obvious catastrophe", async () => {
    const res = await fetch(agent.base + "/exec", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ cmd: "rm -rf / --no-preserve-root" }),
    });
    assert.equal(res.status, 403);
  });

  await t.test("still allows ordinary commands", async () => {
    const { events } = await exec(agent.base, "echo allowed");
    assert.match(text(events, "out"), /allowed/);
  });
});
