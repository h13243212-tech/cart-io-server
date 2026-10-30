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

## Install once

### 1. In the VM: one command

```bash
curl -fsSL https://raw.githubusercontent.com/h13243212-tech/cart-io-server/main/kali/install.sh | sudo bash
```

That clones the repo into `/opt/arena-kali`, installs a `systemd` service,
starts it, and makes it start with the VM every time. No terminal left open, no
re-running anything after a reboot.

```bash
systemctl status arena-bridge          # is it alive?
journalctl -u arena-bridge -n 30       # what has it been doing?
```

No internet in the VM? Clone on the host, copy the folder in, then
`sudo bash kali/install.sh` from inside it — same result.

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

## When it doesn't work

| What you see | What it means |
|---|---|
| `cannot reach the VM` in the panel | The agent is not running, or the port forward is missing. In the VM: `systemctl status arena-bridge`. On the host: re-run the setup script. |
| Agent running, host gets `connection refused` | The VirtualBox NAT case: the agent bound `127.0.0.1` inside the VM, and a NAT forward arrives on the VM's *network* address (`10.0.2.15`). `kali/install.sh` and `kali/start.sh` detect this and bind the adapter. Re-run the installer if you set up before this existed. |
| Adapter is **Bridged**, not NAT | The extension only accepts loopback agent addresses, so it will not reach the VM's LAN IP. Use the `ssh -L` tunnel below. |
| `the VM rejected the token` | The token file changed (reinstall). Clear the token in the popup's **Advanced** box and press CONNECT again. |
| Green dot, model just talks | The chat is not in Direct mode, or the panel is disarmed. |
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
- **Pairing is gated on `Origin: chrome-extension://…`**, a header the browser
  sets and page JavaScript cannot forge. Another browser extension could still
  pair, so every pairing is logged to the journal, and `--no-pair` closes it.
- **The agent binds loopback unless it sees VirtualBox NAT.** With NAT the port
  is reachable only from inside the VM and through the host-side forward, which
  the setup scripts bind to `127.0.0.1`.
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
setup/windows-portforward.bat
setup/mac-linux-portforward.command
extension/manifest.json      MV3; storage + loopback host permissions only
extension/site.js            every DOM guess lives here, nothing else does
extension/prompt.js          the setup prompt injected by CONNECT
extension/content.js         the panel, the settle-debounce, the typing
extension/background.js      the only decider; imports lib/loop.js
extension/lib/loop.js        pure decision logic — no DOM, fully tested
extension/popup.*            Connect, plus Advanced escape hatches
test/                        72 tests, no browser needed
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

## Tests

```bash
npm test        # 72 passing
```

The agent tests spawn the real Python agent on a real socket and check the
contract: exit codes, separated streams, a timeout that actually kills the
process group, output capping, token rejection, the seatbelt, and that `/pair`
refuses every non-extension origin. The setup tests run `kali/start.sh` with a
fake `ip` and a fake `python3`, so they can prove the VirtualBox NAT binding
without a VM. The loop tests cover the parser — including the case where a reply
contains an unterminated fence, which must never execute.

**What is not verified:** the DOM layer has never run against the live arena.ai
markup. The selectors in `site.js` are heuristics. The Diagnose panel and the
manual override boxes exist precisely because that is the part that will break
first when the site changes.

## Uninstall

```bash
sudo bash /opt/arena-kali/kali/install.sh --uninstall     # service + code
```

Then remove the extension from `chrome://extensions`, and drop the `arena-kali`
port forward (VirtualBox → Settings → Network → Advanced).
