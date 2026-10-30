/* ==================================================================
   SETUP TESTS — the shell layer that stands between a VirtualBox NAT
   forward and a working bridge.

   This one earns its keep: an agent bound to 127.0.0.1 inside a NAT'd VM
   is invisible to the host forward ("connection refused" from Windows
   while the agent insists it is listening). start.sh sniffs for the
   10.0.2.15 address and binds the adapter instead. The tests below run
   the real script with a fake `ip` and a fake `python3`, so they see the
   exact argv the agent would receive — no VM, no network.
   ================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** PATH with a lying `ip` and a `python3` that just prints its argv. */
function fakeBin(addr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-bin-"));
  fs.writeFileSync(path.join(dir, "ip"),
    `#!/bin/sh\necho "2: eth0    inet ${addr}/24 brd ${addr} scope global eth0"\n`,
    { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "python3"), '#!/bin/sh\necho "PYARGS:$*"\n', { mode: 0o755 });
  return dir;
}

function runStart({ addr, args = [], env = {} }) {
  const bin = fakeBin(addr);
  return new Promise((resolve) => {
    const p = spawn("bash", [path.join(ROOT, "kali", "start.sh"), ...args], {
      env: { ...process.env, PATH: bin + ":" + process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", () => { fs.rmSync(bin, { recursive: true, force: true }); resolve(out); });
  });
}

test("kali/start.sh and VirtualBox NAT", async (t) => {
  await t.test("binds the adapter when the VM is behind VirtualBox NAT", async () => {
    const out = await runStart({ addr: "10.0.2.15" });
    assert.match(out, /VirtualBox NAT detected/);
    assert.match(out, /PYARGS:bridge_agent\.py .*--host 0\.0\.0\.0/,
      "a loopback-only agent cannot be reached through a NAT forward");
  });

  await t.test("stays on loopback everywhere else", async () => {
    const out = await runStart({ addr: "192.168.1.50" });
    assert.doesNotMatch(out, /VirtualBox NAT detected/);
    assert.doesNotMatch(out, /--host/, "must not widen the bind by default");
  });

  await t.test("an explicit --host wins over detection", async () => {
    const out = await runStart({ addr: "10.0.2.15", args: ["--host", "127.0.0.1"] });
    assert.doesNotMatch(out, /--host 0\.0\.0\.0/);
    assert.match(out, /PYARGS:bridge_agent\.py --host 127\.0\.0\.1/);
  });

  await t.test("AKB_BIND_LOOPBACK=1 opts out (SSH tunnel setups)", async () => {
    const out = await runStart({ addr: "10.0.2.15", env: { AKB_BIND_LOOPBACK: "1" } });
    assert.doesNotMatch(out, /--host/);
  });

  await t.test("says what it is doing rather than binding silently", async () => {
    const out = await runStart({ addr: "10.0.2.15" });
    assert.match(out, /Leave this window open/);
    assert.match(out, /VM can get here except through that forward/);
  });
});

test("the instructions match the script", async (t) => {
  await t.test("README explains the NAT binding", () => {
    const readme = read("README.md");
    assert.match(readme, /Windows 11 \+ VirtualBox/);
    assert.match(readme, /10\.0\.2\.15/);
    assert.match(readme, /connection refused/);
    assert.match(readme, /ssh -L/);
  });

  await t.test("the Windows script replaces its rule instead of stacking them", () => {
    const bat = read("setup/windows-portforward.bat");
    assert.match(bat, /natpf1 delete "arena-kali"/);
    assert.ok(bat.indexOf("natpf1 delete") < bat.indexOf("natpf1 \"arena-kali"),
      "delete must come before add, or re-running fails with a duplicate");
    assert.match(bat, /127\.0\.0\.1,8787/);
  });

  await t.test("the popup still refuses a non-loopback agent address", () => {
    // the forward binds the host's loopback; pointing the extension at a
    // LAN address would quietly turn a private port into a public one.
    const js = read("extension/popup.js");
    assert.match(js, /127\\\.0\\\.0\\\.1\|localhost/);
  });

  await t.test("the repo carries no leftovers", () => {
    assert.equal(fs.existsSync(path.join(ROOT, "prompts")), false);
    const files = fs.readdirSync(ROOT).filter((f) => f !== ".git").sort();
    assert.deepEqual(files, [".gitignore", "README.md", "extension", "kali",
      "package.json", "setup", "test"]);
  });
});
