/* ==================================================================
   SIM — the rules. Pure, deterministic, frame-rate independent.
   ------------------------------------------------------------------
   No DOM, no canvas, no rAF, no wall clock. The renderer, the tests and
   (later) a replay viewer all drive the same file.

   THE CAR MODEL, and why it is this one
   Arcade drift is not vehicle dynamics; it is a shape of feel. This model
   is the classic one that shipped in a hundred good browser racers:

     1. rotate the heading first,
     2. THEN decompose velocity in the NEW car frame.

   Step 2 is the whole trick. Rotating the chassis while the velocity
   vector still points the old way means part of last tick's forward speed
   is now sideways speed. That sideways remainder IS the drift. Grip is
   then applied as an exponential decay on that lateral component — high
   grip kills it instantly (car goes where it points), low grip lets it
   persist (car slides). Handbrake drops lateral grip, which is why it
   starts a slide instead of just slowing you down.

   Doing it in this order also means the model is stable at any timestep:
   there is no force integration to explode, only decay factors. Load in
   the track (corner radius) still decides what's possible, which is what
   makes the corners mean something.
   ================================================================== */
import { nearest } from "./tracks.js";

export const SIM_HZ = 120;
export const SIM_DT = 1 / SIM_HZ;
export const GHOST_HZ = 30;

export const TUNING = {
  car: {
    length: 46,
    width: 24,
    engine: 430,          // forward acceleration, units/s^2
    brake: 1150,
    reverse: 300,
    topSpeed: 470,        // engine fade approaches this; drag settles below it
    drag: 0.15,           // exponential damping, per second
    roll: 25,             // constant rolling resistance, units/s^2
    // Steering is deliberately weak relative to speed: min turn radius grows
    // with velocity, so a corner that is easy at 200 is a wall at 380. This
    // single ratio is what forces braking and makes drifting worth doing.
    steerRate: 1.5,       // rad/s at full lock
    steerRef: 130,        // speed at which steering authority maxes out
    steerFalloff: 0.32,   // fraction of steering lost by top speed
    grip: 3.2,            // lateral grip on asphalt  (slip angle ~18 deg)
    gripHandbrake: 0.9,   // grip while the handbrake is down (slip ~35 deg)
    gripGravel: 2.2,
    handbrakeYaw: 1.2,    // extra rotation the handbrake buys you
    gravelDrag: 1.9,
    wallRestitution: 0.42,
    wallScrub: 0.72,      // fraction of speed kept after a wall contact
  },
  gravel: 76,             // runoff width between the edge line and the wall
  run: { laps: 3, countdown: 2.2 },
};

const C = TUNING.car;
// Number.isFinite, not `v < lo`: NaN fails every comparison, so a client
// sending null/NaN/garbage would otherwise sail straight through into the
// physics and turn the car's position into NaN forever.
const clamp = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < lo ? lo : n > hi ? hi : n;
};

/** A car sitting on the start line, facing the right way. */
export function makeCar(tr) {
  const p = tr.pts[tr.startIndex ?? 0];
  return {
    x: p.x, y: p.y, a: Math.atan2(p.ty, p.tx),
    vx: 0, vy: 0,
    hint: p ? 0 : 0,
    slip: 0, surface: "road", hit: 0,
    s: 0, lastS: 0,
  };
}

/**
 * One physics tick. Mutates `car`. Returns a small report for the renderer
 * (wall impact strength, drift angle) — no rendering state lives here.
 */
export function stepCar(car, input, tr, dt) {
  const steer = clamp(input.steer ?? 0, -1, 1);
  const thr = clamp(input.thr ?? 0, -1, 1);
  const hb = !!input.hb;

  car.hit *= 0.86;                        // impact flash decays

  // --- 1. rotate the chassis -------------------------------------------
  const speed0 = Math.hypot(car.vx, car.vy);
  const authority = Math.min(1, speed0 / C.steerRef);          // no steering at a standstill
  const falloff = 1 - C.steerFalloff * Math.min(1, speed0 / C.topSpeed);
  let yaw = steer * C.steerRate * authority * falloff;
  if (hb && speed0 > 40) yaw += steer * C.handbrakeYaw * authority * 0.5;
  car.a += yaw * dt;

  // --- 2. decompose velocity in the NEW frame --------------------------
  const ca = Math.cos(car.a), sa = Math.sin(car.a);
  let vLong = car.vx * ca + car.vy * sa;
  let vLat = -car.vx * sa + car.vy * ca;

  // --- 3. longitudinal --------------------------------------------------
  if (thr > 0) {
    const fade = Math.max(0, 1 - vLong / C.topSpeed);
    vLong += C.engine * thr * fade * dt;
  } else if (thr < 0) {
    if (vLong > 25) vLong -= C.brake * -thr * dt;              // brake
    else vLong += C.reverse * thr * dt;                        // reverse
  }
  vLong *= Math.exp(-C.drag * dt);
  const rr = C.roll * dt;
  if (Math.abs(vLong) <= rr) vLong = 0; else vLong -= Math.sign(vLong) * rr;

  // --- 4. lateral grip --------------------------------------------------
  // Off the asphalt there is less grip and more drag: cutting a corner
  // costs you, but it is never instantly fatal.
  let grip = hb ? C.gripHandbrake : C.grip;
  let extraDrag = 0;
  if (car.surface === "gravel") { grip = Math.min(grip, C.gripGravel); extraDrag = C.gravelDrag; }
  vLat *= Math.exp(-grip * dt);
  if (extraDrag) vLong *= Math.exp(-extraDrag * dt);

  // --- 4b. self-aligning torque ----------------------------------------
  // Real tyres pull themselves straight; without that, holding the handbrake
  // through a corner rotates the car forever and hands the player a spin they
  // can do nothing about. This is the assist that makes a drift a drift:
  // past the target slip angle, the chassis is nudged to follow its velocity.
  let slipA = Math.atan2(vLat, Math.abs(vLong) + 1e-3);
  const MAX_SLIP = 0.60;                       // ~34 degrees
  if (Math.abs(slipA) > MAX_SLIP) {
    const excess = Math.abs(slipA) - MAX_SLIP;
    car.a += Math.sign(slipA) * Math.min(excess, 0.7) * 7.0 * dt;
    // rebuild the frame for the corrected heading before recomposing
    const nca = Math.cos(car.a), nsa = Math.sin(car.a);
    vLong = car.vx * nca + car.vy * nsa;
    vLat = -car.vx * nsa + car.vy * nca;
    slipA = Math.atan2(vLat, Math.abs(vLong) + 1e-3);
  }

  // --- 5. recompose and integrate --------------------------------------
  const ca2 = Math.cos(car.a), sa2 = Math.sin(car.a);
  car.vx = ca2 * vLong - sa2 * vLat;
  car.vy = sa2 * vLong + ca2 * vLat;
  car.x += car.vx * dt;
  car.y += car.vy * dt;
  car.slip = speed0 > 30 ? Math.abs(slipA) : 0;

  // --- 6. track surface + walls ----------------------------------------
  const n = nearest(tr, car.x, car.y, car.hint);
  car.hint = n.i;
  car.s = n.s;
  const lat = Math.abs(n.lat);
  car.surface = lat > tr.halfWidth ? "gravel" : "road";

  const wall = tr.halfWidth + TUNING.gravel;
  if (lat > wall) {
    // Push back to the wall line, kill the outward velocity, scrub speed.
    // N is the unit normal pointing toward positive lateral.
    const sgn = Math.sign(n.lat) || 1;
    const nx = -n.p.ty * sgn, ny = n.p.tx * sgn;
    const over = lat - wall;
    car.x -= nx * over;
    car.y -= ny * over;
    const vOut = car.vx * nx + car.vy * ny;
    if (vOut > 0) {
      car.vx -= nx * vOut * (1 + C.wallRestitution);
      car.vy -= ny * vOut * (1 + C.wallRestitution);
      car.hit = Math.min(1, vOut / 260);
      const keep = 1 - (1 - C.wallScrub) * Math.min(1, vOut / 300);
      car.vx *= keep; car.vy *= keep;
    }
    car.surface = "gravel";
  }

  return { hit: car.hit, slip: car.slip, surface: car.surface };
}

/* ------------------------------------------------------------------
   A RUN — countdown, lap timing, ghost recording
   ------------------------------------------------------------------ */
export const NEUTRAL = { steer: 0, thr: 0, hb: false };

export function createRun(tr, opts = {}) {
  const run = {
    tr,
    car: makeCar(tr),
    laps: opts.laps ?? TUNING.run.laps,
    t: 0,                       // run clock
    lap: 0,                     // completed laps
    lapT: 0,                    // current lap time
    lapTimes: [],
    best: null,
    dist: 0,
    countdown: TUNING.run.countdown,
    finished: false,
    ghost: opts.ghost ?? null,  // best-lap positions, replayed for the "race yourself" hook
    ghostFrame: 0,
    lapFrames: [],              // frames recorded for the lap in progress
    tick: 0,
  };
  run.car.lastS = run.car.s = tr.pts[tr.startIndex ?? 0].s;
  return run;
}

const FRAME_EVERY = Math.round(SIM_HZ / GHOST_HZ);

/** Advance the run one tick. `input` is ignored during the countdown. */
export function stepRun(run, input) {
  if (run.finished) return run;
  run.tick++;
  run.t += SIM_DT;

  if (run.countdown > 0) {
    run.countdown -= SIM_DT;
    input = NEUTRAL;
  }

  stepCar(run.car, input, run.tr, SIM_DT);

  // progress along the lap, with wrap handling so the line is seamless
  const L = run.tr.len;
  let ds = run.car.s - run.car.lastS;
  if (ds > L / 2) ds -= L;
  if (ds < -L / 2) ds += L;
  if (Math.abs(ds) > 240) ds = 0;         // teleport guard
  run.car.lastS = run.car.s;
  run.dist += ds;

  if (run.countdown <= 0) run.lapT += SIM_DT;

  if (run.tick % FRAME_EVERY === 0 && run.countdown <= 0) {
    run.lapFrames.push({
      t: +run.lapT.toFixed(3),
      x: +run.car.x.toFixed(1),
      y: +run.car.y.toFixed(1),
      a: +run.car.a.toFixed(3),
      d: +run.dist.toFixed(1),   // lap progress, for the live delta readout
    });
  }

  if (run.dist >= L) {
    const lapTime = run.lapT;
    run.lapTimes.push(lapTime);
    if (run.best == null || lapTime < run.best) {
      run.best = lapTime;
      run.ghost = run.lapFrames.slice();
    }
    run.dist -= L;
    run.lap++;
    run.lapT = 0;
    run.lapFrames = [];
    if (run.lap >= run.laps) run.finished = true;
  }
  return run;
}

/* ------------------------------------------------------------------
   AUTOPILOT — not shipped. Used by the test suite to prove every track
   is actually drivable end to end, and to establish a baseline lap time.
   If the autopilot cannot finish a lap without hitting walls, the track
   or the car tuning is wrong.
   ------------------------------------------------------------------ */
export function autopilot(car, tr, lookaheadBase = 90) {
  const speed = Math.hypot(car.vx, car.vy);
  const look = lookaheadBase + speed * 0.34;
  const target = pointAhead(tr, car.s + look);

  const want = Math.atan2(target.y - car.y, target.x - car.x);
  let err = want - car.a;
  while (err > Math.PI) err -= Math.PI * 2;
  while (err < -Math.PI) err += Math.PI * 2;

  const steer = clamp(err * 2.4, -1, 1);

  // slow down for the tightest corner within braking distance
  // Corner speed from the car's actual yaw authority, not a grip guess:
  // it can hold a radius of v/yawRate(v), so v_max ~ R * steerRate.
  const cornerR = Math.min(radiusAhead(tr, car.s, 40, 300), 4000);
  const targetSpeed = Math.min(C.topSpeed, cornerR * C.steerRate * 0.78);
  const thr = speed < targetSpeed - 25 ? 1 : speed > targetSpeed + 40 ? -1 : 0;
  const hb = err > 0.55 && speed > targetSpeed * 1.12;
  return { steer, thr, hb };
}

function pointAhead(tr, s) {
  const { pts, n, len } = tr;
  const d = ((s % len) + len) % len;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].s <= d) lo = mid; else hi = mid - 1;
  }
  return pts[lo];
}

/** Smallest corner radius in the next `dist` units. */
function radiusAhead(tr, s, from, dist) {
  const { pts, n, len } = tr;
  let min = Infinity;
  const step = 12;
  for (let k = from; k < dist; k += step) {
    const d = ((s + k) % len + len) % len;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].s <= d) lo = mid; else hi = mid - 1;
    }
    const i = lo;
    const a = pts[(i - 2 + n) % n], b = pts[i], c = pts[(i + 2) % n];
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca2 = Math.hypot(a.x - c.x, a.y - c.y);
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (area2 > 1e-6) min = Math.min(min, (ab * bc * ca2) / (2 * area2));
  }
  return min;
}
