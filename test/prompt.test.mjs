/* ==================================================================
   PROMPT + WIRING TESTS — the bits that make setup one click.

   The prompt is injected automatically now, which means a mistake in it
   is no longer caught by a human copying it. The dangerous mistake is an
   example block that actually does something: the session is armed when
   the model starts talking, so if the model echoes the example, that
   example runs.
   ================================================================== */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const EXT = path.join(ROOT, "extension");

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** Evaluate extension/prompt.js in a sandbox and return the prompt string. */
function loadPrompt() {
  const sandbox = { window: {} };
  new Function("window", read("extension/prompt.js"))(sandbox.window);
  return sandbox.window.AKB_PROMPT;
}

test("the injected setup prompt", async (t) => {
  const prompt = loadPrompt();

  await t.test("exists and is a single string", () => {
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.length > 200, "too short to teach the format");
    assert.ok(prompt.length < 2000, "too long to survive the composer");
  });

  await t.test("contains exactly one fenced block", () => {
    const fences = prompt.match(/```/g) || [];
    assert.equal(fences.length, 2, "a second block would mean two commands per reply");
  });

  await t.test("tags the block bash so the extension will run it", () => {
    assert.match(prompt, /```bash\n/);
  });

  await t.test("the example command is harmless if the model echoes it", () => {
    const block = prompt.split("```bash\n")[1].split("```")[0].trim();
    const firstWord = block.split(/\s+/)[0];
    // If the model parrots the example on the arming turn, this is what runs.
    assert.ok(["id", "whoami", "pwd", "echo"].includes(firstWord),
      `example command "${firstWord}" is not in the harmless allowlist`);
    assert.doesNotMatch(block, /rm |dd |>\s*\/dev|mkfs|:\(\)/, "the example mutates something");
  });

  await t.test("states the one-block-per-reply rule", () => {
    assert.match(prompt, /one (bash )?block per reply/i);
  });

  await t.test("tells the model not to invent output", () => {
    assert.match(prompt, /never invent|do not invent|don't invent/i);
  });

  await t.test("tells the model how to stop", () => {
    assert.match(prompt, /\bDONE\b/);
  });

  await t.test("describes the result envelope the loop actually sends", () => {
    assert.match(prompt, /\[bridge exit=/);
  });

  await t.test("asks for a block-free first reply", () => {
    const lastLine = prompt.trim().split("\n").at(-1);
    assert.match(lastLine, /READY/i, "the final instruction must ask for READY");
    assert.doesNotMatch(lastLine, /```/, "the final instruction must not contain a block");
  });
});

test("extension wiring", async (t) => {
  const manifest = JSON.parse(read("extension/manifest.json"));
  const cs = manifest.content_scripts[0];

  await t.test("prompt.js loads before content.js, which reads it", () => {
    const js = cs.js;
    assert.ok(js.includes("prompt.js"), "prompt.js is not loaded at all");
    assert.ok(js.indexOf("site.js") < js.indexOf("prompt.js"));
    assert.ok(js.indexOf("prompt.js") < js.indexOf("content.js"));
  });

  await t.test("every script the manifest names exists", () => {
    for (const f of [...cs.js, ...cs.css, manifest.background.service_worker, manifest.action.default_popup]) {
      assert.ok(fs.existsSync(path.join(EXT, f)), `missing extension/${f}`);
    }
  });

  await t.test("the popup has one obvious action", () => {
    const html = read("extension/popup.html");
    assert.match(html, /id="pair"/);
    // the popup must not claim to be the thing that starts the loop
    assert.doesNotMatch(html, /Connect to my VM/);
    assert.match(html, /Test connection/);
    // the token box must not be the primary path any more
    assert.match(html, /<details>/);
    assert.ok(html.indexOf('id="pair"') < html.indexOf('id="token"'));
  });

  await t.test("the build identifies itself, so 'is this the new one?' is answerable", () => {
    const manifest = JSON.parse(read("extension/manifest.json"));
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.match(read("extension/popup.js"), /getManifest\(\)\.version/);
    assert.match(read("extension/content.js"), /extension v.*getManifest\(\)\.version/);
  });

  await t.test("the panel connects on its own: pair, teach, arm", () => {
    const js = read("extension/content.js");
    assert.match(js, /function startSession/);
    // the one click must not send the user to the popup for a token
    assert.match(js, /akb:pair/);
    assert.match(js, /asking the VM for a token/);
    assert.match(js, /setArmed\(true\)/);
    assert.match(js, /AKB_PROMPT/);
    assert.match(js, />CONNECT</);
  });

  await t.test("the background worker can pair", () => {
    const js = read("extension/background.js");
    assert.match(js, /"\/pair"/);
    assert.match(js, /akb:pair/);
    assert.match(js, /pairing-disabled/);
  });

  await t.test("the DOM layer reads rendered code blocks, not just fences", () => {
    const site = read("extension/site.js");
    assert.match(site, /querySelectorAll\("pre"\)/);
    assert.match(site, /codeBlocksIn/);
    assert.match(site, /blocks: codeBlocksIn/);
    // languages are read from the block, never guessed from the text alone
    assert.match(site, /language-/);
  });

  await t.test("blocks survive the trip to the decider", () => {
    assert.match(read("extension/content.js"), /blocks: codeBlocks/);
    assert.match(read("extension/background.js"), /blocks: Array\.isArray\(msg\.blocks\)/);
  });

  await t.test("a block that cannot run is reported, not swallowed", () => {
    const js = read("extension/content.js");
    assert.match(js, /saw \$\{res\.saw\.blocks\} code block/);
    assert.match(js, /not executable/);
  });

  await t.test("the agent logs every command it is asked to run", () => {
    assert.match(read("kali/bridge_agent.py"), /log\("%s %s" % \(route, one_line/);
  });

  await t.test("the agent gates /pair on an extension origin", () => {
    const py = read("kali/bridge_agent.py");
    assert.match(py, /chrome-extension:\/\//);
    assert.match(py, /moz-extension:\/\//);
    assert.match(py, /--no-pair/);
  });
});
