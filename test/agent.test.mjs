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
const AGENT = path.join(HERE, "..", "kali", "bridge_agent.py");
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

/* ------------------------------------------------------------------
   PAIRING — the step that used to be "copy this token into that window".
   The security property under test is precisely that a *web page* cannot
   do it: the browser sets Origin, and page script cannot change it.
   ------------------------------------------------------------------ */
const pairReq = (base, origin) => fetch(base + "/pair", {
  method: "GET",
  headers: origin ? { Origin: origin } : {},
});

test("agent /pair", async (t) => {
  const a = await startAgent();
  t.after(a.cleanup);

  await t.test("hands the token to a browser extension", async () => {
    const res = await pairReq(a.base, "chrome-extension://abcdefghijklmnop");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.token, TOKEN);
    assert.equal(typeof body.host, "string");
    assert.equal(res.headers.get("access-control-allow-origin"),
      "chrome-extension://abcdefghijklmnop");
  });

  await t.test("accepts a Firefox extension too", async () => {
    const res = await pairReq(a.base, "moz-extension://11111111-2222");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).token, TOKEN);
  });

  await t.test("refuses a web page, and says why", async () => {
    // both a plausible attacker page and the site the extension runs on
    for (const origin of ["https://evil.example", "https://arena.ai", "null", "http://127.0.0.1:3000"]) {
      const res = await pairReq(a.base, origin);
      assert.equal(res.status, 403, `origin ${origin} should be refused`);
      const body = await res.json();
      assert.equal(body.token, undefined);
      assert.equal(body.code, "origin", "the extension needs to tell this apart from --no-pair");
    }
  });

  await t.test("accepts a client with no Origin (extension worker, or curl)", async () => {
    // Chrome does not always attach Origin to a privileged extension-worker
    // fetch, and that used to read as "pairing is off". A page cannot omit
    // Origin on the requests it would need in order to read the token.
    const res = await pairReq(a.base, null);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).token, TOKEN);
  });

  await t.test("refuses a lookalike scheme", async () => {
    for (const origin of ["chrome-extension:/x", "chrome-extensionx://a", "CHROME-EXTENSION://a"]) {
      assert.equal((await pairReq(a.base, origin)).status, 403, `origin ${origin} should be refused`);
    }
  });

  await t.test("a paired token actually works", async () => {
    const { token } = await (await pairReq(a.base, "chrome-extension://zzz")).json();
    const { status, body } = await run(a.base, "echo paired-ok", { token });
    assert.equal(status, 200);
    assert.equal(body.out, "paired-ok\n");
  });
});

test("agent --no-pair closes the door", async (t) => {
  const a = await startAgent(["--no-pair"]);
  t.after(a.cleanup);
  const res = await pairReq(a.base, "chrome-extension://abcdefghijklmnop");
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.token, undefined);
  assert.equal(body.code, "disabled", "--no-pair must not look like an origin refusal");
  // the token the user was given still works; only the hand-out stopped
  assert.equal((await run(a.base, "echo still-fine")).body.out, "still-fine\n");
});

/* ------------------------------------------------------------------
   The demo page: a chat UI the agent serves itself, so the whole loop can
   be proven without arena.ai, an account, or a model. It has to be there
   and it has to be the real file.
------------------------------------------------------------------ */
test("agent serves the local demo page", async (t) => {
  const a = await startAgent();
  t.after(a.cleanup);

  await t.test("GET /demo returns the chat page", async () => {
    const res = await fetch(a.base + "/demo");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    const html = await res.text();
    assert.match(html, /contenteditable/);     // a composer to type into
    assert.match(html, /language-/);           // it really renders code blocks
  });

  await t.test("the demo needs no token, and leaks nothing", async () => {
    const res = await fetch(a.base + "/demo");
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.doesNotMatch(html, /Bearer|token/i);
  });

  await t.test("health is still protected on the same server", async () => {
    assert.equal((await fetch(a.base + "/health")).status, 401);
  });
});

/* ==================================================================
   MCP — the same agent speaks the Model Context Protocol on /mcp
   (Streamable HTTP) and on stdio. These are the four messages every MCP
   client sends before it will use a server, plus the failure paths.
   ================================================================== */
const mcp = async (base, msg, token = TOKEN) => {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: typeof msg === "string" ? msg : JSON.stringify(msg),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
};

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

test("agent /mcp — the handshake every client does", async (t) => {
  const { base, cleanup } = await startAgent();
  try {
    await t.test("initialize names the server and negotiates a version", async () => {
      const { status, json, headers } = await mcp(base, INIT);
      assert.equal(status, 200);
      assert.equal(json.jsonrpc, "2.0");
      assert.equal(json.id, 1);
      assert.equal(json.result.serverInfo.name, "arena-kali");
      assert.ok(["2025-06-18", "2025-03-26", "2024-11-05"].includes(json.result.protocolVersion));
      assert.ok(json.result.capabilities.tools);
      assert.match(headers.get("mcp-session-id") || "", /^arena-kali-/);
    });

    await t.test("notifications/initialized gets 202 and no body", async () => {
      const r = await mcp(base, { jsonrpc: "2.0", method: "notifications/initialized" });
      assert.equal(r.status, 202);
      assert.equal(r.json, null);
    });

    await t.test("tools/list advertises run_command with a real schema", async () => {
      const { json } = await mcp(base, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = json.result.tools;
      const names = tools.map((x) => x.name);
      assert.ok(names.includes("run_command"));
      assert.ok(names.includes("read_file"));
      assert.ok(names.includes("write_file"));
      assert.ok(names.includes("list_directory"));
      assert.ok(names.includes("system_info"));
      for (const tool of tools) {
        assert.equal(typeof tool.description, "string");
        assert.equal(tool.inputSchema.type, "object");
      }
      const rc = tools.find((x) => x.name === "run_command");
      assert.deepEqual(rc.inputSchema.required, ["command"]);
    });

    await t.test("tools/call actually runs the command on this machine", async () => {
      const { json } = await mcp(base, {
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "run_command", arguments: { command: "echo from-mcp; id -un" } },
      });
      assert.equal(json.result.isError, false);
      const text = json.result.content[0].text;
      assert.match(text, /from-mcp/);
      assert.match(text, /\[exit 0/);
    });

    await t.test("a failing command reports isError, not a crashed server", async () => {
      const { json } = await mcp(base, {
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "run_command", arguments: { command: "exit 7" } },
      });
      assert.equal(json.result.isError, true);
      assert.match(json.result.content[0].text, /exit 7/);
      // and the server is still alive
      const ping = await mcp(base, { jsonrpc: "2.0", id: 5, method: "ping" });
      assert.equal(ping.status, 200);
    });

    await t.test("an unknown tool is an error result, an unknown method is -32601", async () => {
      const tool = await mcp(base, {
        jsonrpc: "2.0", id: 6, method: "tools/call",
        params: { name: "rm_rf_everything", arguments: {} },
      });
      assert.equal(tool.json.result.isError, true);
      const method = await mcp(base, { jsonrpc: "2.0", id: 7, method: "no/such" });
      assert.equal(method.json.error.code, -32601);
    });

    await t.test("no token means no MCP", async () => {
      const r = await mcp(base, INIT, null);
      assert.equal(r.status, 401);
      assert.equal(r.json.error, "unauthorised");
    });

    await t.test("a batch is answered point by point", async () => {
      const r = await mcp(base, [
        { jsonrpc: "2.0", id: 10, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 11, method: "tools/list" },
      ]);
      assert.equal(r.status, 200);
      assert.equal(r.json.length, 2);
      assert.deepEqual(r.json.map((x) => x.id), [10, 11]);
    });
  } finally { cleanup(); }
});

test("agent --mcp-stdio — what Claude Desktop actually spawns", async () => {
  const proc = spawn("python3", [AGENT, "--mcp-stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => { out += d; });
  const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
  send(INIT);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "run_command", arguments: { command: "echo stdio-ok" } } });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && out.split("\n").filter(Boolean).length < 2) {
    await new Promise((r) => setTimeout(r, 50));
  }
  proc.kill("SIGKILL");
  const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, "the notification must not produce a line");
  assert.equal(lines[0].result.serverInfo.name, "arena-kali");
  assert.match(lines[1].result.content[0].text, /stdio-ok/);
});
