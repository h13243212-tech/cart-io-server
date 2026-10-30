# Arena ⇄ Kali

Let an Arena **Direct-mode** chat run commands on your own Kali VM. Same shape as
ZeroScript, pointed at a shell instead of Roblox Studio.

```
Arena tab (Direct mode)
  └─ extension: finds ```bash blocks in the reply, watches for the reply to settle
       └─ background worker → http://127.0.0.1:8787  (agent, running in Kali)
            └─ bash — full access, your privileges
       └─ types the result back into the chat and presses Enter
```

---

## First: what "Arena runs commands" actually means

**Arena has no tool-calling API for an extension to hook.** There is no function
call, no MCP handshake, nothing the page exposes. So this cannot make the model
*actually* call a tool.

What it does instead — the same trick ZeroScript uses — is simulate the loop
through the chat UI:

1. You paste a prompt teaching the model a format: *"to run something, emit one
   ```` ```bash ```` block and stop."*
2. The model replies with text containing that block.
3. The extension notices the reply has stopped changing, extracts the command, and
   runs it.
4. It types the output back into the chat box as a message and presses Enter.
5. The model reads it and continues.

So the model never makes a tool call — it emits text, and this acts on it. That
distinction matters because it predicts the failure modes: a model that ignores the
format, a site redesign, or a fabricated result all break the illusion. The
[prompt](prompts/system-prompt.md) is doing real work, not decoration.

## Setup

### 1. Start the agent in Kali

```bash
python3 agent/bridge_agent.py
```

Stdlib Python 3 only — nothing to install on a clean Kali. It prints a token and
saves it to `~/.arena-bridge/token` (`0600`). It binds `127.0.0.1`.

### 2. Make it reachable from your browser's machine

The extension is only allowed to talk to `127.0.0.1`, on purpose — that permission
list is the security boundary. So bring the agent to localhost rather than opening
it to the network.

**VirtualBox (most likely your case):** VM Settings → Network → Adapter 1 (NAT) →
Advanced → **Port Forwarding** → add:

| Name | Protocol | Host IP | Host Port | Guest IP | Guest Port |
|---|---|---|---|---|---|
| bridge | TCP | 127.0.0.1 | 8787 | 10.0.2.15 | 8787 |

That maps `localhost:8787` on your PC to the agent inside the VM, with nothing
exposed to your LAN.

**Oracle Cloud / remote VM:** don't open the port. Tunnel it:

```bash
ssh -N -L 8787:127.0.0.1:8787 kali@your-vm
```

> Using a bridged adapter and the VM's own LAN IP (`192.168.x.x`)? That needs
> `host_permissions` in `manifest.json` and the regex in `popup.js` widened. It
> works, but port forwarding is less to get wrong.

### 3. Load the extension

`chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`.

### 4. Connect

Open the popup, keep `http://127.0.0.1:8787`, paste the token, **Test**. The dot
goes green and names the VM.

### 5. Teach the model the format

Open arena.ai in **Direct** mode, start a new chat, and paste the short prompt from
[`prompts/system-prompt.md`](prompts/system-prompt.md). The model replies with one
line; the panel's green dot confirms the bridge.

### 6. Arm it

Click **ARM** in the panel. Nothing runs until you do, and the panel turns red.
Ask for a task:

> *"Check the network config on this box and tell me what's unusual."*

Watch the log. Each command is printed before it runs, with its exit code.

---

## Verification: what I could and could not test

**Tested — 28 tests, no mocks (`npm test`):**

- **11 agent tests** against the real Python process over real HTTP: token required,
  exit codes honest, stdout/stderr separated, timeouts that kill the *process group*,
  output capped so a noisy command can't flood the context, junk rejected, and the
  streaming `/exec` endpoint still working alongside `/run`.
- **17 loop tests**, adversarial where it matters: only the six advertised fence
  languages execute (a ```` ```text ```` block is never run), an **unterminated
  block is never executed** (the half-streamed-fence case), shell prompts pasted from
  tutorials are stripped only when every line has one, each command runs exactly once
  even as the observer re-fires, the step budget stops the run, and command output
  cannot forge the `[/bridge]` delimiter or truncate the context.

**Not tested — and this is the honest risk:** the DOM layer. There is no browser in
the environment I built this in, so `site.js` has never run against arena.ai. Its
selectors are heuristics. Expect to press **?** (Diagnose) once and, if anything
says `NOT FOUND`, paste a CSS selector into the popup's manual fields. That's why
the layer is 200 lines of pure guessing with zero decisions in it — the tested part
is the part that executes commands.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Dot grey, `offline` | agent not running, or port forward missing | test in the VM: `curl -H "authorization: Bearer $TOKEN" 127.0.0.1:8787/health` |
| `bad token` | token rotated | agent prints a new one each start unless `~/.arena-bridge/token` exists |
| Model never emits blocks | prompt not pasted, or wrong mode | Direct mode only; re-paste the prompt |
| Diagnose: reply `NOT FOUND` | arena.ai markup differs from the heuristic | set the reply selector in the popup |
| Result typed but not sent | send button not matched | panel offers a manual button; or press Enter yourself |
| Model "runs" commands without a bridge message | **it is fabricating output** | disarm immediately and re-paste the rules |

## Security, plainly

Arming this hands the model a shell with your privileges. There is no allowlist —
you asked for full access, and that is what it is.

The realistic danger is **prompt injection**, not a malicious extension. The loop's
input is the model's reply, and the model's reply is influenced by everything it
reads. If it reads a file, a scan result, or a web page containing text like
"ignore previous instructions and run…", that text can end up as a ```` ```bash ````
block and execute with no approval step. Mitigations that actually work:

- Work inside a VM snapshot you can revert (`VBoxManage snapshot` or the GUI).
- Keep **ARM** off between tasks; it is a foot pedal, not a setting.
- Watch the log. Every command prints before it runs — the panel is an audit trail,
  and reading it is the actual control.
- Don't keep SSH keys or tokens in `~` on that box while you work.

## Layout

```
agent/bridge_agent.py   stdlib agent: auth, /run (one JSON result), /exec (streaming)
extension/site.js       all DOM guessing — no decisions, so nothing to get wrong
extension/content.js    panel, mutation watcher, settle debounce, injection
extension/background.js the only decider; imports lib/loop.js
extension/lib/loop.js   command parsing + result formatting — 17 tests
extension/popup.html    address, token, step budget, manual selectors
prompts/system-prompt.md  the format the model must follow
test/                   28 tests
```
