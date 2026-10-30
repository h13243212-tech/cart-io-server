/* ==================================================================
   TESTS — node --test. No browser, no canvas, no mocks.
   Everything the game does with rules is pure, so the whole sim and the
   whole track set can be verified headlessly. That is the point of
   keeping sim.js free of DOM access: if a rule only exists in render.js
   it cannot be tested, and if it only exists on the client it can be
   cheated.
   ================================================================== */
import test from "node:test";
import assert from "node:assert/strict";

import { curatedTracks, validate, nearest, GEOMETRY_LIMITS } from "../src/tracks.js";
import {
  createRun, stepRun, stepCar, makeCar, autopilot, TUNING,
  SIM_DT, SIM_HZ, NEUTRAL,
} from "../src/sim.js";

const tracks = curatedTracks();

test("every curated circuit passes the geometry test", () => {
  for (const tr of tracks) {
    const v = validate(tr);
    assert.ok(v.ok, `${tr.id}: ${v.reasons.join(", ")}`);
    assert.ok(tr.n > 100, `${tr.id}: too few centreline samples`);
    assert.ok(tr.len > GEOMETRY_LIMITS.minLength, `${tr.id}: lap too short`);
  }
});

test("a circuit is reproducible from its seed", () => {
  const a = curatedTracks()[0];
  const b = curatedTracks()[0];
  assert.equal(a.len, b.len);
  for (let i = 0; i < a.n; i++) {
    assert.equal(a.pts[i].x, b.pts[i].x);
    assert.equal(a.pts[i].y, b.pts[i].y);
  }
});

test("the simulation is deterministic for a given input sequence", () => {
  const tr = tracks[0];
  const script = [];
  for (let i = 0; i < 120 * 8; i++) {
    script.push({
      steer: Math.sin(i / 40),
      thr: i < 400 ? 1 : 0.4,
      hb: i % 240 > 200,
    });
  }
  const runA = createRun(tr, { laps: 9 });
  const runB = createRun(tr, { laps: 9 });
  for (const cmd of script) { stepRun(runA, cmd); stepRun(runB, cmd); }

  assert.equal(runA.car.x, runB.car.x, "position must be bit-identical");
  assert.equal(runA.car.y, runB.car.y);
  assert.equal(runA.car.a, runB.car.a);
  assert.deepEqual(runA.lapTimes, runB.lapTimes);
});

test("physics is identical at 60 Hz, 144 Hz and 165 Hz", () => {
  // The claim being tested is that DISPLAY rate cannot change the physics.
  // The accumulator is allowed to be one step short when a frame lands
  // mid-step, so the honest version is: the state after N accumulated
  // frames equals the state after exactly the same number of raw ticks,
  // bit for bit, at every refresh rate.
  const tr = tracks[0];
  const cmdAt = tick => ({ steer: Math.sin(tick / 50), thr: 1, hb: false });

  const accumulate = (hz, seconds) => {
    const run = createRun(tr, { laps: 9 });
    const frameDt = 1 / hz;
    let acc = 0;
    let ticks = 0;
    for (let f = 0; f < Math.round(seconds * hz); f++) {
      acc += frameDt;
      let steps = 0;
      while (acc >= SIM_DT && steps < 10) {
        stepRun(run, cmdAt(run.tick));
        acc -= SIM_DT;
        steps++; ticks++;
      }
      if (steps === 10) acc = 0;
    }
    return { run, ticks };
  };

  const direct = (n) => {
    const run = createRun(tr, { laps: 9 });
    for (let i = 0; i < n; i++) stepRun(run, cmdAt(run.tick));
    return run;
  };

  const results = [60, 144, 165].map(hz => accumulate(hz, 6));
  for (const { run, ticks } of results) {
    const ref = direct(ticks);
    assert.equal(run.car.x, ref.car.x, "accumulated frames diverged from raw ticks");
    assert.equal(run.car.y, ref.car.y);
    assert.equal(run.car.a, ref.car.a);
  }
  // and no refresh rate may drift more than a single step from another
  const counts = results.map(r => r.ticks);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1,
    `tick counts diverged across refresh rates: ${counts.join(", ")}`);
});

test("the car cannot leave the ribbon", () => {
  const tr = tracks[1];
  const run = createRun(tr, { laps: 9 });
  const limit = tr.halfWidth + TUNING.gravel + 2;
  for (let i = 0; i < 120 * 25; i++) {
    // slam the wheel to one side and hold the throttle down
    stepRun(run, { steer: 1, thr: 1, hb: i % 60 < 30 });
    const n = nearest(tr, run.car.x, run.car.y, run.car.hint);
    assert.ok(Math.abs(n.lat) <= limit,
      `escaped the track: lat ${n.lat.toFixed(1)} > ${limit.toFixed(1)}`);
  }
});

test("the handbrake produces a real drift angle", () => {
  const tr = tracks[0];
  const open = { ...tr, halfWidth: 1e6 };   // no walls, so only the tyres matter
  const car = makeCar(tr);
  for (let i = 0; i < 120 * 4; i++) stepCar(car, { steer: 0, thr: 1, hb: false }, open, SIM_DT);
  let peak = 0;
  for (let i = 0; i < 120 * 2; i++) {
    stepCar(car, { steer: 1, thr: 0.5, hb: true }, open, SIM_DT);
    peak = Math.max(peak, car.slip);
  }
  const deg = peak * 180 / Math.PI;
  assert.ok(deg > 25, `drift too shallow: ${deg.toFixed(1)} deg`);
  assert.ok(deg < 88, `car spun: ${deg.toFixed(1)} deg`);
});

test("speed stays bounded", () => {
  const tr = tracks[0];
  const open = { ...tr, halfWidth: 1e6 };
  const car = makeCar(tr);
  for (let i = 0; i < 120 * 30; i++) stepCar(car, { steer: 0, thr: 1, hb: false }, open, SIM_DT);
  const speed = Math.hypot(car.vx, car.vy);
  assert.ok(Number.isFinite(speed), "speed went non-finite");
  assert.ok(speed <= TUNING.car.topSpeed + 1, `speed ${speed} exceeds top speed`);
  assert.ok(speed > 300, `car never got going: ${speed}`);
});

test("the countdown holds the car still", () => {
  const tr = tracks[0];
  const run = createRun(tr, {});
  const x0 = run.car.x, y0 = run.car.y;
  const ticks = Math.floor(TUNING.run.countdown * SIM_HZ) - 2;
  for (let i = 0; i < ticks; i++) stepRun(run, { steer: 1, thr: 1, hb: false });
  assert.ok(Math.abs(run.car.x - x0) < 1e-9, "car moved before the flag");
  assert.ok(Math.abs(run.car.y - y0) < 1e-9);
  assert.equal(run.lapT, 0, "lap clock started during the countdown");
});

test("laps are counted and timed, and a ghost is kept", () => {
  const tr = tracks[0];
  const run = createRun(tr, { laps: 2 });
  let guard = 0;
  while (!run.finished && guard++ < 120 * 300) stepRun(run, autopilot(run.car, tr));

  assert.ok(run.finished, "autopilot never finished two laps");
  assert.equal(run.lapTimes.length, 2);
  for (const t of run.lapTimes) assert.ok(t > 5 && t < 90, `implausible lap time ${t}`);
  assert.ok(run.best > 0 && run.ghost && run.ghost.length > 20, "no ghost recorded");
  // ghost frames must advance in time, or replay drifts
  for (let i = 1; i < run.ghost.length; i++) {
    assert.ok(run.ghost[i].t >= run.ghost[i - 1].t, "ghost frames out of order");
  }
});

test("the autopilot can get round every circuit without hitting a wall", () => {
  for (const tr of tracks) {
    const run = createRun(tr, { laps: 1 });
    let wallFrames = 0, guard = 0;
    while (!run.finished && guard++ < 120 * 200) {
      stepRun(run, autopilot(run.car, tr));
      if (run.car.hit > 0.05) wallFrames++;
    }
    assert.ok(run.finished, `${tr.id}: autopilot could not finish a lap`);
    const pct = wallFrames / guard * 100;
    assert.ok(pct < 2, `${tr.id}: autopilot spent ${pct.toFixed(1)}% of the lap on the walls`);
  }
});

test("hostile input cannot corrupt the car", () => {
  const tr = tracks[0];
  const run = createRun(tr, { laps: 1 });
  const junk = [NaN, Infinity, -Infinity, 1e9, -1e9, undefined, null, "1", {}];
  for (let i = 0; i < 120 * 5; i++) {
    const v = junk[i % junk.length];
    stepRun(run, { steer: v, thr: v, hb: true });
  }
  assert.ok(Number.isFinite(run.car.x) && Number.isFinite(run.car.y), "position went non-finite");
  assert.ok(Number.isFinite(run.car.vx) && Number.isFinite(run.car.vy), "velocity went non-finite");
});
