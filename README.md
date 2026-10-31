# Arena ⇄ Kali

Ask an Arena chat to do something and it happens on your own Kali VM — real
shell, real tools, output typed back into the chat for you.

```
you:     which ports are listening on this box?
arena:   runs  <bash> ss -tulpn </bash>   and nothing else
bridge:  [bridge exit=0 12ms] Netid State Local Address:Port … [/bridge]
arena:   Three services. 22 is ssh, 8080 is your app…
```

**Install once — two commands. After that it is one button, forever.**

---

## Prove it works before trusting it (2 minutes)

The extension's one blind spot is reading a command out of a web page. So the
agent serves a fake chat UI — same shape as a real one, no account, no model,
no internet:

**<http://127.0.0.1:8787/demo>**

1. Press **CONNECT** in the panel on that page.
2. Type `run hostname` and send.
3. The page replies with a `Bash` block; the panel should print
   `$ hostname; id -un`, then type the result back into the chat by itself.

If that works, the bridge works — port, token, execution, and the loop. Any
remaining problem is specific to arena.ai's markup, and the panel log will
name it. If it does *not* work, the failure is in the bridge, not the site.

---

## Install once

### 1. In the VM: one command

```bash
git clone https://github.com/h13243212-tech/cart-io-server arena-kali
sudo bash arena-kali/kali/install.sh
```

(Or, if `git` is a hassle, the same thing in one line —
`curl -fsSL https://raw.githubusercontent.com/h13243212-tech/cart-io-server/main/kali/install.sh | sudo bash`.)

That clones the repo into `/opt/arena-kali`, installs a `systemd` service,
starts it, and makes it start with the VM every time. No terminal left open, no
re-running anything after a reboot.

```bash
systemctl status arena-bridge          # is it alive?
journalctl -u arena-bridge -n 30       # what has it been doing?
```

No internet in the VM? Clone on the host, copy the folder in, then
`sudo bash kali/install.sh` from inside it — it installs from that copy instead
of downloading again.

### 2. On the machine with the browser: one double-click

- **Windows** — `setup\windows-portforward.bat`
- **macOS / Linux** — `setup/mac-linux-portforward.command`

Type your VM's name exactly as VirtualBox shows it. **Shut the VM down first** —
that is what lets the rule be saved permanently instead of lasting until the
next shutdown. (Run it with the VM on and the script will tell you.)

Check it:

```bash
curl -i http://127.0.0.1:8787/health     # 401 "unauthorised" = the port works
```

`401` is the *good* answer — something is listening and refusing unknown
callers. `connection refused` means the agent is not reachable; the script
prints what to look for.

**Skip this step entirely if your browser runs inside the VM.**

### 3. Load the extension (once, 20 seconds)

`chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick
the `extension/` folder → pin it to the toolbar.

## Every time

1. Start the VM. The agent starts itself.
2. Open arena.ai in a chat that is in **Direct mode**.
3. Press **CONNECT** in the panel.

That one click asks the VM for a token, teaches the model the format, sends it,
and arms the loop. Nothing is typed, pasted or copied. Then just ask:

> which ports are listening on this box?
> stand up a tiny ssh honeypot and show me the log
> why is nginx 502ing?

Each command appears as a `$ …` line in the panel; the output is typed back
into the chat automatically. Click **ARMED — click to stop** (or close the tab)
to disarm.

### Why one click and not zero

A browser extension cannot start a process inside your VM — that is a browser
security boundary, not a design choice, and it is the one thing that stops this
from being literally "install and forget". One-time install plus one click per
session is as close as the platform allows.

---

## Use it as an MCP server (any MCP client, not just the browser)

The agent is a **real MCP server** — Model Context Protocol 2025-06-18,
JSON-RPC 2.0, no `pip install`, no venv. Same process as the bridge, same
token, so there is nothing extra to start:

```
POST http://127.0.0.1:8787/mcp     Streamable HTTP
python3 /opt/arena-kali/kali/bridge_agent.py --mcp-stdio    stdio
```

Tools: `run_command`, `read_file`, `write_file`, `list_directory`,
`system_info`.

**Proof it is really MCP** — two commands. Get the token once
(in the VM: `sudo cat /root/.arena-bridge/token`), then from **PowerShell on
Windows** (the forward already carries this):

```powershell
$T = "paste-the-token-here"
curl.exe -s -X POST http://127.0.0.1:8787/mcp -H "Authorization: Bearer $T" -H "content-type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"run_command\",\"arguments\":{\"command\":\"hostname; id -un\"}}}"
```

Expected — anything else is a setup problem, not a protocol problem:

```json
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text",
 "text":"kali\nroot\n[exit 0 · 6 ms]"}],"isError":false}}
```

Protocol conformance is pinned by tests, not by hope: `initialize`,
`notifications/initialized` → 202 with an empty body, `tools/list`,
`tools/call` (success and failure), unknown tool, unknown method (`-32601`),
batches, a missing token (`401`), and the stdio transport end to end.

**Claude Desktop / Cursor / anything that takes a URL** — add to the client's
MCP config (Claude Desktop on Windows:
`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kali": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer PASTE-THE-TOKEN-HERE" }
    }
  }
}
```

**Anything that spawns a process** (Claude Code, Cline, …) — run it inside the
VM instead, where no token crosses a port:

```json
{ "mcpServers": { "kali": {
    "command": "python3",
    "args": ["/opt/arena-kali/kali/bridge_agent.py", "--mcp-stdio"] } } }
```

The tool surface follows **MCP-Kali-Server** (`TriV3`, MIT) — execute, read,
write, inspect. The protocol implementation here is ours and stdlib-only, which
is the difference between "clone and run" and "install Python packaging first".

## When it doesn't work

| What you see | What it means |
|---|---|
| `cannot reach the VM` in the panel | The agent is not running, or the port forward is missing. In the VM: `systemctl status arena-bridge`. On the host: re-run the setup script. |
| Agent running, host gets `connection refused` | The VirtualBox NAT case: the agent bound `127.0.0.1` inside the VM, and a NAT forward arrives on the VM's *network* address (`10.0.2.15`). `kali/install.sh` and `kali/start.sh` detect this and bind the adapter. Re-run the installer if you set up before this existed. |
| Adapter is **Bridged**, not NAT | The extension only accepts loopback agent addresses, so it will not reach the VM's LAN IP. Use the `ssh -L` tunnel below. |
| `the VM rejected the token` | The token file changed (reinstall). Clear the token in the popup's **Advanced** box and press CONNECT again. |
| Green dot, model just talks | The chat is not in Direct mode, or the panel is disarmed. |
| Works on `/demo` but not on arena.ai | The bridge is fine; arena's markup differs. Press `?` (blocks found / `<pre>` count) or `⤓` (downloads a report) and send it. |
| `captured a untagged block` then nothing | The block was found but its language is unknown and there was more than one. Ask for a `bash` block. |
| `saw 1 code block(s) [python] — not executable` | The reply contained a block, but not in a shell language. Ask for a `bash` block. |
| `no chat input box found` | arena.ai changed its markup. Press `?` in the panel — **Diagnose** reports what it found — then paste selectors into the popup's **Advanced** fields. |
| Commands run, model ignores the results | It drifted from the format. Open a fresh chat and press CONNECT again. |

Remote VM instead of VirtualBox? Skip step 2 and tunnel:

```bash
ssh -N -L 8787:127.0.0.1:8787 kali@your-vm
```

---

## How it works, and why it is shaped like this

Arena has no tool-calling API for a Direct-mode chat, so the loop is simulated
through the chat UI itself — the same trick ZeroScript uses for Roblox Studio:

```
chat reply ──▶ extension scrapes the bash code block
           ──▶ POST http://127.0.0.1:8787/run
           ──▶ agent runs it, returns one JSON object
           ──▶ extension types "[bridge exit=0 12ms] … [/bridge]" back, presses Enter
```

`/run` answers in a single JSON object (`code`, `ms`, `out`, `err`, `timedOut`,
`truncated`, `cwd`) because that result has to survive being pasted as one chat
message.

Decisions worth knowing:

- **The extension is the only thing that talks to the agent.** An https page
  cannot `fetch` `http://127.0.0.1`, and a content script inherits that
  restriction — only the extension's service worker, which declares
  `host_permissions`, can reach it.
- **Pairing refuses page origins.** A web page cannot forge its `Origin`, and
  CORS headers are only echoed for allowed origins, so a page cannot read a
  token even if it can trigger the request. A *missing* `Origin` is accepted —
  Chrome does not always attach one to a privileged extension-worker fetch, and
  a local process that could send none could read the token file anyway.
  Another extension could still pair, so every attempt is logged to the journal
  and `--no-pair` closes the door.
- **The agent binds loopback unless it sees VirtualBox NAT.** With NAT the port
  is reachable only from inside the VM and through the host-side forward, which
  the setup scripts bind to `127.0.0.1`.
- **arena.ai's message list runs backwards.** `<ol class="flex-col-reverse">`
  means the DOM order is *newest first*, so "the last matching element on the
  page" is the **oldest** message — a node that never changes. That single fact
  is why early versions looked asleep while the model was emitting commands.
  The provider layer now reads the newest assistant turn explicitly.
- **The loop watches for code blocks, not for "the assistant's reply".**
  Message containers differ per site and get re-rendered; a command always
  ends up in `<pre>`/`<code>`. Reading the last block on the page — excluding
  the panel's own — is far more durable than guessing which div is the reply.
- **Commands are read from the page's code blocks, not from backticks.**
  Rendered markdown keeps no fence characters — arena.ai turns a ```bash fence
  into a styled block with a "Bash" chip — so the extension collects `<pre>`
  elements and their labels. Fence parsing is only the fallback for plain-text
  renderings.
- **Disarmed by default, one block per reply, deduplicated.** The extension
  marks a message as consumed *before* it runs it, so a re-render cannot execute
  the same command twice.
- **The setup prompt is injected, not copied.** Its example block is `id` — if
  the model echoes the example, the worst that happens is it prints your
  username.

## This is full access, on purpose

The service runs as **root**, because that is what makes `nmap -sS`, packet
capture and package installs work without password prompts in a VM with no TTY.

> A prompt-injected or confused model can run anything root can. `rm -rf /` is
> one bad reply away.

What people actually do about that, in ascending order of effort:

- click **ARMED — click to stop** whenever you are not actively working;
- keep a VM snapshot, take one before risky work, revert after;
- read the `$ …` lines — they are the whole audit log;
- `sudo bash /opt/arena-kali/kali/install.sh --uninstall` when you are done for
  the day, and install again tomorrow.

## Files

```
kali/install.sh              one-time installer: systemd service, on boot
kali/start.sh                run it in the foreground instead
kali/bridge_agent.py         the agent (stdlib only, no pip installs)
kali/kali_mcp.py             the MCP server: tools, schemas, stdio transport
kali/demo.html               fake chat UI, served at /demo, proves the loop
setup/windows-portforward.bat
setup/mac-linux-portforward.command
extension/manifest.json      MV3; storage + loopback host permissions only
extension/site.js            every DOM guess lives here, nothing else does
extension/prompt.js          the setup prompt injected by CONNECT
extension/content.js         the panel, the settle-debounce, the typing
extension/background.js      the only decider; imports lib/loop.js
extension/lib/loop.js        pure decision logic — no DOM, fully tested
extension/popup.*            Test connection, plus Advanced escape hatches
test/                        130 tests: loop, agent over HTTP, MCP, setup, DOM
test/dom.test.mjs            runs site.js in jsdom — block reading, composer

```

Agent flags (for `kali/start.sh`, or add them to the unit's `ExecStart`):

```bash
--port 8787        change the port (also change the forward and the popup)
--host 127.0.0.1   bind address; 0.0.0.0 only if a forward needs it
--no-pair          refuse /pair; the token must be pasted by hand
--deny-rm          refuse a few catastrophic patterns (a seatbelt, not a lock)
--token            supply the token instead of generating one
--token-file       where the token is kept (default ~/.arena-bridge/token)
```

### Where the arena.ai knowledge comes from

The selectors and behaviours above (the reverse-ordered `<ol>`, `.prose`
bodies, `justify-end` for user turns, `div.not-prose` code wrappers, the
`<form>` textarea composer, the `aria-label="Send message"` button) were
validated live against arena.ai by the **ZeroScript Free** project
(GPL-3.0, `sebattfg/ZeroScript-Free`). We took the *facts* — which element is
what — and wrote our own implementation; no GPL code is copied into this
repository.

## Tests

```bash
npm install     # once: jsdom, for the DOM tests (they skip without it)
npm test        # 130 passing
```

The agent tests spawn the real Python agent on a real socket and check the
contract: exit codes, separated streams, a timeout that actually kills the
process group, output capping, token rejection, the seatbelt, and that `/pair`
refuses every non-extension origin. The setup tests run `kali/start.sh` with a
fake `ip` and a fake `python3`, so they can prove the VirtualBox NAT binding
without a VM. The loop tests cover the parser — including the case where a reply
contains an unterminated fence, which must never execute.

**What is not verified:** the arena.ai selectors come from another project's
live validation of arena.ai — accurate as of their last check, never exercised
against a live session from this repo. They are concrete, not guesses, but a
site redesign breaks them the way it breaks every scraper. `/demo` isolates
that: if commands run there and not on arena.ai, the problem is the page, not
the bridge. The Diagnose panel and the manual override boxes stay for exactly
that day.

## Uninstall

```bash
sudo bash /opt/arena-kali/kali/install.sh --uninstall     # service + code
```

Then remove the extension from `chrome://extensions`, and drop the `arena-kali`
port forward (VirtualBox → Settings → Network → Advanced).
