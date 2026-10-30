# Arena ⇄ Kali

Ask an Arena chat to do something and it happens on your own Kali VM — real
shell, real tools, output typed back into the chat for you.

No commands to copy, no output to paste, no token to retype.

```
you:     which ports are listening on this box?
arena:   runs  <bash> ss -tulpn </bash>   and nothing else
bridge:  [bridge exit=0 12ms] Netid State Local Address:Port … [/bridge]
arena:   Three services. 22 is ssh, 8080 is your app…
```

**Clone → run → pair → start.** Five minutes, most of it a VM boot.

---

## The four steps

### 1. Start the agent inside Kali

In a terminal **inside the VM**:

```bash
git clone https://github.com/h13243212-tech/cart-io-server arena-kali
bash arena-kali/kali/start.sh
```

Leave that window open — it *is* the bridge. It prints a token and says
"click Pair"; you never need to write the token down.

*(No `git`? `sudo apt install -y git`. No `python3`? `sudo apt install -y python3`.)*

### 2. Open the port — only if your browser is outside the VM

If you browse arena.ai **inside** the VM (Kali desktop, Firefox/Chromium in the
VM), skip this step entirely.

Otherwise the VM's `8787` has to appear as `127.0.0.1:8787` on your own machine:

- **Windows** — double-click `setup/windows-portforward.bat`, type your VM name.
- **macOS / Linux** — double-click `setup/mac-linux-portforward.command`, type your VM name.

Run it while the VM is **running**. It replaces the rule each time, so re-running
is always safe. No VirtualBox, or the VM is on another machine? Tunnel instead:

```bash
ssh -N -L 8787:127.0.0.1:8787 kali@your-vm
```

Check it worked — `401 unauthorised` is the *good* answer, it means something is
listening and refusing unauthenticated callers:

```bash
curl -i http://127.0.0.1:8787/health
```

### 3. Load the extension and pair

Chrome, Edge or Brave → `chrome://extensions` → turn on **Developer mode** →
**Load unpacked** → pick the `extension/` folder in this repo. Pin it.

Click the icon → **Pair with my VM**. The dot turns green and names the machine
it is attached to. That was the token step; it is automatic now.

### 4. Use it

Open arena.ai, start a chat, make sure it is in **Direct mode** — the panel does
not appear in the agentic modes because there is nothing to bridge there.

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
| It all worked yesterday | VMs and port forwards do not survive reboots. Re-run steps 1–2. |

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

Delete the extension from `chrome://extensions`, remove the `arena-kali` port
forward (VirtualBox → Settings → Network → Advanced), and delete
`~/.arena-bridge/` in the VM.
