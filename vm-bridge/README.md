# Arena ⇄ VM Bridge

Run shell commands on your own VM from a browser tab — with a panel, a
right-click-free "run this selection" chip, and a token-authenticated loopback
agent. Works with `arena.ai` out of the box; the agent is a plain HTTP server, so
any page you allowlist can use it.

**Workflow it's built for:** ask Arena for a command, highlight it in the chat,
click `▶ VM`, watch the output stream back into the panel. You stay the one who
decides what runs.

---

## Why an extension at all

This is the whole design justification, and it's not obvious:

An `https://arena.ai` page **cannot** `fetch("http://127.0.0.1:8787")`. The browser
blocks it twice over — first as **mixed content** (a secure page may not call an
insecure endpoint), and then by **CORS** even if it got through. A page also can't
call a private `192.168.x.x` address for the same reasons.

A Manifest V3 **service worker with `host_permissions`** is exempt from both. It is
the only context in the browser that can reach your loopback agent from a
third-party origin. That is why this is an extension and not a script tag.

```
  arena.ai tab (https)
   │  panel / selection chip  ── postMessage ──▶  content.js
   │                                                │ chrome.runtime
   ▼                                                ▼
  wrapper page                              background service worker
  (your browser)                             │ fetch, no CORS, no mixed content
                                             ▼
                                     http://127.0.0.1:8787
                                             │  (SSH tunnel if the VM is remote)
                                             ▼
                                   bridge_agent.py  ── subprocess ──▶ bash
```

## What it does and does not do

**Does:** execute commands you or a page initiate (page-initiated commands need
approval by default), stream stdout and stderr separately as they arrive, report
exit codes, enforce timeouts and an output ceiling, and show VM health.

**Does not:** let Arena's AI run commands by itself. Arena's front end has no tool
hook to call, and inventing one by scraping the chat would be fragile and
presumptuous. Three honest integration levels exist:

1. **The panel** — type or paste a command. Works today, no cooperation needed.
2. **Run-selection chip** — highlight any command in the chat, click to run. This is
   the practical loop, and it needs nothing from Arena.
3. **Page API** — if Arena ever exposes a hook, or you drive it from a userscript:
   ```js
   window.postMessage({ source: "arena-page", type: "bridge.exec", cmd: "ls -la" }, location.origin)
   ```
   Messages are only accepted from the page's own window and origin, and land in an
   approval chip unless you tick "trust this page" in the popup.

---

## Setup

### 1. Start the agent inside the VM

```bash
python3 agent/bridge_agent.py --deny-rm
```

No dependencies — stdlib Python 3, so it runs on a clean Kali. It prints a token
and writes it to `~/.arena-bridge/token` (mode `0600`). It binds `127.0.0.1` only.

### 2. If the VM is remote, tunnel it — do not open a port

```bash
ssh -N -L 8787:127.0.0.1:8787 kali@your-vm
```

This is the important step. The agent executes arbitrary shell commands; exposing
that port to the internet means anyone who finds it and the token owns the box.
An SSH tunnel means the port never leaves the loopback interface on either end.
If you must bind elsewhere, the agent prints a loud warning — read it.

### 3. Load the extension

`chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`.

### 4. Paste the token

Open the extension popup, confirm the address is `http://127.0.0.1:8787`, paste the
token, hit **Test**. The dot goes green and names the host.

### Try the whole chain without the extension

```bash
node tools/serve.mjs        # http://localhost:5175
```

The harness talks to the agent directly and uses the *same* NDJSON parser as the
extension, so if a command streams cleanly there, the transport is sound.

---

## Security model

The honest summary: **anyone holding the token can run shell commands as your user
on that machine.** Everything below is about making that boundary hard to cross
and the blast radius small.

| Control | Why |
|---|---|
| Token required on every request | Compared with `hmac.compare_digest`; there is no unauthenticated mode, because "just for testing" is how these end up exposed. |
| 401 is deliberately vague | Doesn't tell a scanner whether the endpoint exists or the token was merely wrong. |
| Loopback bind by default | The agent warns loudly if bound elsewhere. Tunnel instead. |
| CORS only for extension + localhost origins | An arbitrary website cannot read responses even with a valid token in a URL. |
| Page commands need approval | Default off. Any third-party script on the page could otherwise drive your VM. |
| Output rendered as `textContent` | Command output can contain anything a shell can print; markup is never parsed. |
| Output ceiling (2 MB/stream) | `yes` cannot wedge the tab or the worker. |
| Timeout + `killpg` | Kills the process **group**, so `bash -c 'a \| b'` leaves no straggler. |
| Concurrency cap (3) | One tab cannot fork-bomb the box. |
| `--deny-rm` seatbelt | A seatbelt, not a lock: it stops the fat-fingered `rm -rf /`, and anyone with a token can walk around it in seconds. It is documented as such on purpose. |

**Key management:** the token is generated on first run and reused. Rotate it
by deleting `~/.arena-bridge/token` and restarting the agent, then re-pasting in
the popup.

## What has actually been verified

`npm test` in this directory — 25 tests, no mocks:

- **16 agent integration tests** that spawn the real Python agent and speak real
  HTTP: token required, wrong token rejected, stdout/stderr separated, exit codes
  preserved, output arriving incrementally rather than buffered, timeouts killing
  the process *group*, oversized/malformed/empty requests refused, CORS preflight
  for extension origins, and no CORS for a random website origin.
- **9 protocol tests** for the parser every byte passes through: NDJSON split at
  every possible chunk boundary, partial lines kept, malformed lines survived,
  runaway buffers dropped, request validation and clamping, and origin checks.

Not verified here: Chrome loading the extension. There is no browser in this
sandbox, so the popup, content script and panel have been checked by static
analysis and by exercising the identical protocol through the harness. Load it and
expect to fix cosmetic issues; the transport underneath is tested.

## Known limitations

- **No stdin / no PTY.** Commands are fire-and-forget with streamed output. `sudo`
  password prompts, `vim`, and anything interactive will hang until the timeout.
  A PTY is the natural v2 and needs a WebSocket, not chunked HTTP.
- **Service worker lifetime.** MV3 can suspend an idle worker. Each event relayed
  touches a `chrome` API, which keeps it alive during a run; a multi-minute
  command with long silences is still a risk.
- **No file transfer yet.** Sending and pulling files is the obvious next feature
  and the protocol has room for it.
- **Cosmetic coupling to arena.ai.** `content.js` matches `arena.ai` only. Change
  the `matches` array for other hosts — nothing else is site-specific.

## Layout

```
agent/bridge_agent.py     stdlib HTTP agent: auth, exec, streaming, guards
extension/manifest.json   MV3, permissions kept to storage + two loopback hosts
extension/background.js   the only context allowed to fetch the agent
extension/content.js      panel, selection chip, page API (textContent only)
extension/lib/protocol.js pure parsing/validation — unit tested
extension/popup.html/js   address, token, trust toggle, real test button
test/                     25 tests
tools/serve.mjs           dev server + /agent proxy for previews
tools/harness.html        extension-free way to drive the agent
```
