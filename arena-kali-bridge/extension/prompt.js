/* ==================================================================
   The setup prompt, injected into the chat by the START button so nobody
   has to copy-paste anything.

   Two things here are load-bearing:

   1. The example block uses `id`. If the model repeats the example — and
      models love to — the worst case is that it prints your user id. An
      example like `nmap` or `rm` would make an echoed example dangerous,
      because the extension arms itself when the session starts.

   2. It ends with "reply with READY". The first reply then contains no
      executable block, which gives the loop a clean, harmless first turn.

   Kept as a plain script (not a module) because content scripts cannot
   import. test/prompt.test.mjs reads this file and asserts the example is
   exactly one block and that block is harmless.
   ================================================================== */
window.AKB_PROMPT = `You are connected to a Kali Linux machine through a bridge. You can run commands on it.

To run a command, reply with ONE code block tagged bash, and put nothing after it:

\`\`\`bash
id
\`\`\`

Then stop and wait. The output comes back to you as a message starting with [bridge exit=...].

Rules:
1. One bash block per reply, always the last thing in the reply.
2. Never invent or guess output. If you need to know something, run a command and wait.
3. Combine steps with && or ; instead of sending several blocks.
4. Never repeat the example above.
5. When the task is finished, write DONE and stop sending blocks.

Reply with just READY and nothing else.`;
