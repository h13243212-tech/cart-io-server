# New game — shortlist for CrazyGames

The old Cart.io bundle is gone from the working tree; it's still in git history at
`e9c7b0f` (`git show e9c7b0f:shared/sim.js`) if you ever want it back.

---

## 1. The platform rules that actually shape the design

These aren't opinions, they're the gates. Design against them from hour one, not
at submission.

| Constraint | Number | Design consequence |
|---|---|---|
| Initial download | ≤ 50 MB; **≤ 20 MB** for mobile-homepage eligibility | Ship a tiny build. 20 MB is the number that matters — it's the traffic jackpot. |
| Total build / files | 250 MB / 1,500 files | Fine for a 2D game. Rules out heavy 3D asset packs. |
| Time to gameplay | ≤ 20 s when assets load externally | Menu → playing must be one tap. No logo splash, no tutorial wall. |
| Browsers | Must work in Chrome + Edge; disabled on Safari if it runs badly; must be smooth on a 4 GB Chromebook | Your render budget is a weak laptop, not your dev machine. |
| Iframe size | Readable at 907×510 desktop, 800×450 mobile, devicePixelRatio 1 | UI must survive being small. No 12px text. |
| Physics | Must behave identically at 144 Hz and 165 Hz | Fixed timestep, always. Variable-`dt` physics is an instant QA fail. |
| Controls | Never use Escape, Ctrl/Cmd+W; no custom fullscreen button | Plat controls come from the SDK/portal. |
| Content | English, PEGI 12, no external links, no app-store links, no cross-promo | Boring but fatal if missed. |
| Monetization | SDK ads only; SDK optional for Basic Launch, required for any revenue | Ads are the SDK's job, not yours. |
| Launch | Basic Launch = limited audience, 7–21 days, judged on conversion + playtime + retention; then invite to Full Launch | **The review audience is small.** Your game must be good with 3 players online. |
| Payout | €100 minimum, monthly | Don't plan revenue around month one. |

Two non-obvious consequences:

- **Genre keywords drive discovery.** CrazyGames traffic arrives largely through
  category browse and search ("tower defense", "drift", "2 player", "zombie").
  A game with no one-word category is invisible no matter how clever it is. So:
  **familiar genre + one sharp twist.** Not a new genre.
- **The Basic Launch audience is small and short.** Anything that needs a crowd
  (multiplayer `.io`) looks dead during the exact window it's being judged —
  unless bots carry it. Cart.io solved this; a fresh `.io` would have to solve it
  again, from zero reputation.

Also from their quality guidelines: don't use a generic name you don't own the IP
for ("Chess" bad, "Super Chess" fine), keep the genre stable after submission, and
be able to add content easily — they explicitly reward games that can grow.

---

## 2. The shortlist

### A. Ghost-race drift game — `SLIPSTREAM` ★ my pick
**Keyword:** drift / racing / car

Tight 30–45 s courses, 3 laps, one-thumb steering, a **ghost of your best run** on
every attempt, plus a daily seed track and a lightweight track editor.

**Why this one wins for this team:**
- **It reuses the one real asset you have: a deterministic pure-sim module.** A
  ghost is just a recorded input stream replayed through the same sim — no server
  at any point. The skill you already demonstrated (physics identical at 60/144/165 Hz,
  rules in one testable file) is *the entire difficulty* of this genre.
- **Zero population dependency.** Full experience with one player. Survives Basic
  Launch's tiny audience and costs nothing to run.
- **Chasing a ghost is the most retry-addictive loop on the web.** Playtime per
  session is the metric being judged; this genre produces 30+ retries naturally.
- **Tiny and instant.** Canvas 2D, procedurally drawn, well under 5 MB. Mobile-homepage
  eligible, so it can sit in the 20 MB tier.
- **Content scales cheaply**, which the guidelines reward: each new track is a data
  file, the editor generates an infinite supply, the daily seed drives return visits.

**Risk:** feel. A drift game with bad handling is worthless — but handling is exactly
the thing you can tune in a headless test harness. **Scope for v1:** one car, one
track, ghost, PB leaderboard, 3 tracks total.

---

### B. Same-screen 2-player party game — `TANDEM`
**Keyword:** 2 player / multiplayer

Two players, one keyboard (or two thumbs on one phone), chained together by a
rope. One drives, one shoots/steers the rope. Co-op chaos in 60-second rounds.

**Why:** "2 player" is one of the most-searched terms on portals and is chronically
under-supplied with *good* entries. No server, no bots, no population problem.
Extremely cheap to build and highly shareable — people play it with whoever is
sitting next to them, which is a retention mechanic no `.io` game has.
**Risk:** reach. It's a "play with a friend" game; a solo visitor bounces.

---

### C. Roguelite tower defense — `SIEGE LINE`
**Keyword:** tower defense / strategy

~15-minute runs: place 8 towers, draft 1 of 3 cards between waves, escalating
waves, permanent unlocks between runs.

**Why:** the highest average playtime of any single-player genre on these portals,
very mobile-friendly (tap to place), and content is cheap to author.
**Risk:** the most saturated category on the platform. Needs a hard twist
(movable towers mid-wave? towers on a moving train?) and gorgeous art to clear the
"not easily confused with another game" bar.

---

### D. Daily puzzle — word / logic / numbers
**Keyword:** word / brain / puzzle

One new handcrafted board per day, streaks, shareable result grid, archive of past
days behind ads.

**Why:** daily games are the best retention mechanic in the industry and portals
have a real gap here. Tiny build, mobile-first, no art risk.
**Risk:** lowest ad revenue per session (short sessions, few slots), and you're
competing with the New York Times' cultural gravity. Handcrafting a year of boards
is more work than it looks.

---

### E. Multiplayer `.io` again — your existing edge
Highest ceiling on the platform (multiplayer titles get the biggest promotion and
the best session lengths), lowest floor. You already have the architecture: rooms,
intent-only clients, server-owned truth, bot backfill. But it needs a full-time
server, an audience on day one, and bots good enough to fool a QA reviewer during a
7-day window with almost nobody online.

Only worth it if you already know the concept is a hit.

---

## 3. Recommendation

**Build A.** It converts your one genuine advantage (testable, deterministic,
frame-rate-independent physics) into the genre where that advantage is the whole
game, with zero server cost and zero dependence on other players being online.
B is the pick if you want something you can finish in a weekend and that spreads by
word of mouth. E is the pick if you want to swing for the fences.

## 4. Shape of the build (if A)

```
index.html          SDK v3 <script> in <head>, canvas, one screen
src/sim.js          THE RULES. Pure. No DOM. Deterministic. Tested in node.
src/render.js       canvas 2D, pseudo-3D or top-down, no assets to download
src/input.js        keyboard + touch, remappable (AZERTY-safe: not raw WASD codes)
src/main.js         fixed-timestep accumulator loop: sim at 120 Hz, render via rAF
src/sdk.js          thin CrazyGames adapter — gameplayStart/Stop, ads. Guarded so
                    the game runs on localhost with no SDK.
test/sim.test.js    node:assert — determinism, ghost replay equality, collision
```

- Fixed-timestep accumulator is non-negotiable: it's how "identical at 144 Hz and
  165 Hz" gets satisfied and how ghosts stay bit-exact.
- Vanilla JS + Canvas, no engine, no framework. Adding three.js later is a
  rendering swap, not a rewrite.
- Everything drawn procedurally in v1 — no image assets at all means a ~200 KB build.
- `npm start` serves a dev build on 0.0.0.0; a single `npm run build` emits a zip
  with `index.html` at the root, under 20 MB, ready for the developer portal.

Say the word and I'll scaffold A and get a playable drift-feel prototype in front of
you today.
