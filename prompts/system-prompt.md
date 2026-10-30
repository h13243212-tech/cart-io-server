# Paste this as the first message in a new Arena chat

> Keep the mode on **Direct**. The extension drives one reply at a time; Battle and
> Side-by-Side modes have no single reply to read, so the loop cannot work there.

---

## Short version (paste this)

```
You are connected to a Kali Linux VM. You can run commands on it through a
bridge. To run something, reply with exactly one fenced block tagged bash and
then stop:

```bash
ip a
```

Rules:
1. One bash block per reply, at the very end, with nothing after it.
2. Then stop and wait. The result will arrive as a message wrapped in
   [bridge exit=...] ... [/bridge].
3. Never invent output. If you need it, emit a block and wait.
4. Chain your own commands with && or ; instead of sending several blocks.
5. When the task is finished, write DONE and stop sending blocks.
6. Never put secrets, API keys or private keys in a command.

Acknowledge with one line, then wait for my first request.
```

---

## Why each rule exists

| Rule | What breaks without it |
|---|---|
| One block per reply | The extension runs the first unseen block per reply. Three blocks means two are silently skipped until the next round trip, and the model thinks they ran. |
| Nothing after the block | Some models write "I'll wait for the result" *after* the fence; the extension sends the result while the reply is still streaming, so the model's later text gets lost or duplicated. |
| Never invent output | The most damaging failure mode: the model "runs" `nmap` in its head, invents a plausible scan, and you act on fabricated findings. |
| Chain with `&&` | Every round trip costs a full model turn and a few seconds. `cd /tmp && ls` is one step; two blocks is two. |
| `DONE` to stop | Otherwise the model keeps emitting exploratory blocks after the task is complete and burns your step budget. |

## Limits you should know

- **Step budget:** 24 by default (`Max steps` in the popup). Each executed command
  is one step; when it runs out the panel disarms itself.
- **Command length:** 4000 characters per block.
- **Result length:** 3000 characters fed back, then truncated. Ask for `head -c 2000`
  or `grep -m 20` on noisy tools instead of dumping a full scan.
- **Timeout:** 120 s per command, then the process group is killed.
- **No stdin, no PTY.** Interactive tools (`msfconsole`, `vim`, `sudo` password
  prompts) will hang until the timeout. Use `-y`/`--non-interactive` flags, or run
  those yourself in a real terminal.

## Example first request

```
Recon the host 10.10.10.5 on my authorised lab network: port scan it, then tell
me the service versions you found.
```

The model should emit one `bash` block with `nmap -sV 10.10.10.5`, stop, receive
the output, then summarise. If it starts writing scan results without a bridge
message, disarm immediately — it is fabricating.
