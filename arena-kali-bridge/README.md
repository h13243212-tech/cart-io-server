# Arena ⇄ Kali

Ask an Arena chat to do something, and it happens on your own Kali VM — real
shell, real tools, output typed back into the chat for you.

No commands to copy, no output to paste, no token to retype.

Two pieces:

| Piece | Runs where | Job |
|---|---|---|
| `kali/bridge_agent.py` | inside the VM | executes commands, answers on `127.0.0.1:8787` |
| `extension/` | your browser | reads the chat, runs what the model asks, types the result back |

**Four steps.** About five minutes, most of it downloads and a VM boot.

---

## 1. Start the agent inside Kali

Get the `kali/` folder into the VM (drag & drop, `scp`, shared folder — whatever
you already use), then:

```bash
bash kali/start.sh
```

Double-clicking `start.sh` works in most file managers too. **Leave that window
open** — it is the bridge. It prints a token and tells you to click Pair; you do
not need to write the token down.

`python3` missing? `sudo apt install -y python3`.

## 2. Open the port on your machine (once)

The agent listens on the VM's own loopback. Your browser is outside the VM, so
`127.0.0.1:8787` has to be forwarded in.

- **Windows** — double-click `setup/windows-portforward.bat`, type your VM name.
- **macOS / Linux** — double-click `setup/mac-linux-portforward.command`, type your VM name.

Run it while the VM is **running**. It replaces the rule each time, so re-running
is always safe.

Not VirtualBox, or the VM is on another machine? Skip the script and tunnel:

```bash
ssh -N -L 8787:127.0.0.1:8787 kali@your-vm
```

## 3. Load the extension and pair

Chrome, Edge or Brave → `chrome://extensions` → turn on **Developer mode** →
**Load unpacked** → pick the `extension/` folder. Pin it to the toolbar.

Click the icon → **Pair with my VM**. The dot turns green and names the machine
it is attached to. That was the token step; it is automatic now.

## 4. Use it

Open arena.ai, start a chat, and make sure it is in **Direct mode** — the panel
does not appear in the agentic modes because there is nothing to bridge there.

A small panel appears in the corner:

1. press **START SESSION** — it explains the format to the model and arms the loop;
2. wait for `READY`;
3. ask for anything — *"which ports are listening on this box?"*, *"stand up a
   tiny ssh honeypot and show me the log"*, *"why is nginx 502ing?"*

Each command the model sends appears as a `$ …` line in the panel, and the
output is typed back into the chat automatically. Click **ARMED — click to
stop** (or close the tab) to disarm.

---

## When it doesn't work

| What you see | What it means |
|---|---|
| `Nothing listening on 8787` | Agent not started, or step 2 not done. The VM must be *running* when you run the setup script. |
| `Pairing is switched off` | The agent was started with `--no-pair`. Copy the token from its window into the popup's **Advanced** box. |
| Green dot, but the model just talks | The chat is not in Direct mode, or the panel is not armed. |
| `no chat input box found` | arena.ai changed its markup. Press `?` in the panel — **Diagnose** reports what it found — then paste selectors into the popup's **Advanced** fields. |
| Commands run, model ignores the results | It drifted from the format. Open a fresh chat and press **START SESSION** again. |
| Everything ran fine yesterday | VMs and forwards do not survive reboots. Re-run step 1 and step 2. |

A raw check, without the browser:

```bash
curl -i http://127.0.0.1:8787/health     # 401 "unauthorised" = the port works
```

401 is the *good* answer here: it proves something is listening and refusing
unauthenticated callers.

---

## How it works, and why it is shaped like this

Arena has no tool-calling API for a Direct-mode chat, so the loop is simulated
through the chat UI itself — the same trick ZeroScript uses for Roblox Studio:

```
chat reply ──▶ extension scrapes the ```bash block
           ──▶ POST http://127.0.0.1:8787/run
           ──▶ agent runs it, returns one JSON object
           ──▶ extension types "[bridge exit=0 12ms] … [/bridge]" back and presses Enter
```

`/run` answers in a single JSON object (`code`, `ms`, `out`, `err`, `timedOut`,
`truncated`, `cwd`) because that result has to survive being pasted as one chat
message.

Decisions worth knowing:

- **The extension is the only thing that talks to the agent.** An https page
  cannot `fetch` `http://127.0.0.1`, and a content script inherits that
  restriction — only the extension's service worker, which declares
  `host_permissions`, can reach it.
- **The agent binds loopback only.** It is never exposed to your network. If you
  pass `--host 0.0.0.0` it prints a warning, because anything that can reach
  that port can run shell commands as you.
- **Pairing is gated on `Origin: chrome-extension://…`**, a header the browser
  sets and page JavaScript cannot forge. Another browser extension could still
  pair, so every pairing is logged to the agent's window, and `--no-pair` closes
  it entirely.
- **Disarmed by default, one block per reply, deduplicated.** The extension
  marks a message as consumed *before* it runs it, so a re-render cannot execute
  the same command twice.
- **The setup prompt is injected, not copied.** Its example block is `id` — if
  the model echoes the example, the worst that happens is it prints your
  username.

## This is full access, on purpose

The agent runs commands as your user, with no approval prompt and no directory
jail. That is the point — it is a shell, not a babysitter — and it means:

> A prompt-injected or confused model can run anything you can. Deleting your
> home directory is one bad reply away.

What people actually do about that, in ascending order of effort:

- disarm the panel (one click) whenever you are not actively working;
- keep a VM snapshot, take one before risky work, revert after;
- give the VM a hostname you will recognise in the panel header;
- read the `$ …` lines — they are the whole audit log.

## Files

```
kali/bridge_agent.py         the agent (stdlib only, no pip installs)
kali/start.sh                launcher, checks python3
setup/windows-portforward.bat
setup/mac-linux-portforward.command
extension/manifest.json      MV3; storage + loopback host permissions only
extension/site.js            every DOM guess lives here, nothing else does
extension/prompt.js          the setup prompt injected by START SESSION
extension/content.js         the panel, the settle-debounce, the typing
extension/background.js      the only decider; imports lib/loop.js
extension/lib/loop.js        pure decision logic — no DOM, fully tested
extension/popup.*            Pair, plus Advanced escape hatches
prompts/system-prompt.md     the same contract, documented (for pasting by hand)
test/                        53 tests, no browser needed
```

Agent flags:

```bash
python3 kali/bridge_agent.py --help
  --port 8787        change the port (also change the forward and the popup)
  --no-pair          refuse /pair; the token must be pasted by hand
  --deny-rm          refuse a few catastrophic patterns (a seatbelt, not a lock)
  --token            supply the token instead of generating one
  --token-file       where the token is kept (default ~/.arena-bridge/token)
```

## Tests

```bash
npm test        # 53 passing
```

The agent tests spawn the real Python agent on a real socket and check the
contract: exit codes, separated streams, a timeout that actually kills the
process group, output capping, token rejection, the seatbelt, and that `/pair`
refuses every non-extension origin. The loop tests cover the parser — including
the case where a reply contains an unterminated fence, which must never execute.

**What is not verified:** the DOM layer has never run against the live arena.ai
markup. The selectors in `site.js` are heuristics. The Diagnose panel and the
manual override boxes exist precisely because that is the part that will break
first when the site changes.

## Uninstall

Delete the extension from `chrome://extensions`, delete the `arena-kali` port
forward (`setup` scripts replace it; VirtualBox → Settings → Network → Advanced
removes it), and delete `~/.arena-bridge/` in the VM.
