# Slipstream

A one-thumb drift racer for the browser. Three laps, and a translucent ghost of
your best lap chasing you the whole way round.

No engine, no framework, no dependencies, no image assets. ~61 KB shipped.

```bash
npm start          # http://localhost:5173
npm test           # 11 tests, headless, no browser needed
npm run check      # autopilot laps every circuit and reports lap times
npm run build      # assembles dist/ and checks the portal size limits
```

**Controls** — arrows or `WASD` to steer, up to accelerate, down to brake,
`Space` to handbrake, `R` to restart. On touch: auto-throttle, two steer pads,
brake and handbrake. Keys are bound by physical position, so AZERTY keyboards
get ZQSD automatically.

---

## Why this game

CrazyGames judges a submission in two stages: a Basic Launch to a **limited**
audience for 7–21 days, scored on conversion, playtime and retention, and only
then a monetised Full Launch. That makes a multiplayer game structurally risky —
it is judged during the one window where nobody is online. A ghost racer is
fully playable with a population of one, has the retry loop that produces long
sessions (players chase a ghost 30+ times without noticing), and needs no server
at all.

It also turns the one real engineering advantage available here — a deterministic,
frame-rate-independent, testable simulation — into the game itself. A ghost is
simply a recorded position stream played back through the same renderer.

## The architecture

```
index.html        one screen, SDK tag in <head>, all CSS inline
src/sim.js        THE RULES. Pure. No DOM. Deterministic. 120 Hz fixed step.
src/tracks.js     Track geometry: generator, fillet maths, validation, queries.
src/render.js     Canvas 2D. Reads sim state, never writes it.
src/input.js      Keyboard + touch -> one analogue intent.
src/sdk.js        CrazyGames adapter. Every call guarded; game runs without it.
src/main.js       State machine, fixed-timestep accumulator, HUD, persistence.
test/sim.test.js  11 tests. node:test, no browser, no mocks.
tools/            Dev server, build check, seed sweep, headless drive test.
```

### Three decisions worth knowing about

**1. Fixed timestep, no exceptions.** The sim advances only in exact 1/120 s
steps; the refresh rate decides how many steps run per frame, nothing else. This
is a portal requirement (physics must behave identically at 144 Hz and 165 Hz)
and it is also what makes ghost playback exact. `test/sim.test.js` proves it by
running the same input schedule through 60, 144 and 165 Hz accumulators and
asserting the state is bit-identical to running that many raw ticks.

**2. Tracks are generated, then validated, and a bad one cannot ship.** Hand
placing control points produced a corner with a 14-unit radius — physically
impossible to drive. So circuits are built from a seeded jittered polygon whose
corners are replaced with exact-radius circular arcs (straights stay straight,
which Chaikin smoothing destroyed), then run through a geometry test: minimum
corner radius, clearance between non-adjacent parts of the road, lap length. The
three shipped circuits are seeds that passed. `tools/track-sweep.mjs` found them;
`npm test` re-checks them on every run.

**3. Steering authority is deliberately weak relative to speed.** Minimum turn
radius grows with velocity: ~150 units at crawling pace, ~400 at top speed. The
tightest corner on every circuit is 167–180 units, so every hairpin forces you
off the throttle. Without that ratio the bot could take the whole lap flat out,
which it did, and a drift game where you never brake is pointless.

### The car

Rotate the chassis first, *then* decompose velocity in the new car frame. Rotating
while the velocity vector still points the old way converts some forward speed
into sideways speed — that remainder is the drift. Grip is an exponential decay
on the lateral component, so the handbrake simply lowers the decay rate. A
self-aligning torque kicks in past ~34° of slip, which is what keeps a drift a
drift instead of an unrecoverable spin (it was one before the test caught it).

Everything tunable is in `TUNING` at the top of `src/sim.js`. `npm run check`
prints lap times, top speed, drift angle and wall contacts after any change.

## Submission checklist

Verified automatically by `npm run build`:

- [x] 61 KB initial download (portal limit 50 MB; 20 MB for the mobile homepage)
- [x] 7 files (limit 1,500), relative paths only, no external assets
- [x] No ad code outside the SDK; no custom fullscreen button
- [x] Reads correctly at 907×510 and 800×450, `devicePixelRatio` 1
- [x] English, PEGI 12, works with an ad blocker

Still to do before uploading:

- [ ] Playtest the handling. Every number here was tuned headlessly against an
      autopilot; feel is the one thing that needs a human. `TUNING` is the file.
- [ ] Cover art and a name check — the portal rejects generic names and icons
      that clash with existing games.
- [ ] Hook `gameplayStart`/`gameplayStop` are already wired; confirm ads appear
      on the results screen (they must never interrupt a lap).
- [ ] Decide on the daily circuit. `generateTrack(seed)` already produces a
      fresh, validated track from any seed, so a dated seed gives a daily mode
      for about ten lines of work.

## Advisory note on names

`Slipstream` is a working title. Check it against existing trademarks and the
portal's library before committing to it — the quality guidelines explicitly
reject names that collide.
