/* ==================================================================
   HEADLESS DRIVE TEST  (dev tool)
   ------------------------------------------------------------------
   Runs the autopilot around each circuit and reports lap times, wall
   contacts, top speed and how much of the lap is spent sliding. This is
   the stand-in for playtesting while there is no browser in the sandbox:
   if the bot cannot get round, a human certainly cannot.

   Run: node tools/drive-test.mjs [--trace]
   ================================================================== */
import { curatedTracks } from "../src/tracks.js";
import { createRun, stepRun, autopilot, TUNING, SIM_DT } from "../src/sim.js";

const trace = process.argv.includes("--trace");

for (const tr of curatedTracks()) {
  const run = createRun(tr, { laps: 3 });
  let hits = 0, worstHit = 0, maxSpeed = 0, slipSum = 0, gravel = 0, ticks = 0;
  let stuckTicks = 0, lastProgress = 0, travelled = 0;

  while (!run.finished && run.t < 400) {
    const input = autopilot(run.car, tr);
    stepRun(run, input);
    const sp = Math.hypot(run.car.vx, run.car.vy);
    maxSpeed = Math.max(maxSpeed, sp);
    slipSum += run.car.slip;
    if (run.car.hit > 0.05) { hits++; worstHit = Math.max(worstHit, run.car.hit); }
    if (run.car.surface === "gravel") gravel++;
    ticks++;

    if (ticks % 240 === 0) {
      travelled = run.lap * tr.len + run.dist;
      if (travelled - lastProgress < 200) stuckTicks++;
      lastProgress = travelled;
    }
    if (ticks > 200 * 120) break;
  }

  const laps = run.lapTimes.map(t => t.toFixed(2)).join("  ");
  console.log(`\n${tr.id} — ${tr.name}  (lap ${tr.len.toFixed(0)} units)`);
  console.log(`  finished      ${run.finished ? "yes" : "NO — ran out of time or got stuck"}`);
  console.log(`  lap times     ${laps || "none"}`);
  console.log(`  best          ${run.best ? run.best.toFixed(2) + "s" : "—"}   avg speed ${run.best ? (tr.len / run.best * 3.6 / 10).toFixed(0) + " km/h" : "—"}`);
  console.log(`  top speed     ${(maxSpeed * 0.5).toFixed(0)} km/h displayed`);
  console.log(`  wall frames   ${hits} (${(hits / ticks * 100).toFixed(1)}%)  worst ${worstHit.toFixed(2)}`);
  console.log(`  off-asphalt   ${(gravel / ticks * 100).toFixed(1)}% of frames`);
  console.log(`  mean slip     ${(slipSum / ticks * 180 / Math.PI).toFixed(1)} deg`);
  if (stuckTicks) console.log(`  STUCK         ${stuckTicks} stalls of 2s`);

  if (trace) {
    const r2 = createRun(tr, { laps: 1 });
    let line = "";
    for (let k = 0; k < 120 * 6; k++) {
      stepRun(r2, autopilot(r2.car, tr));
      if (k % 24 === 0) line += `${(Math.hypot(r2.car.vx, r2.car.vy) * 0.5).toFixed(0)} `;
    }
    console.log(`  speed trace   ${line}`);
  }
}

/* Straight-line sanity: top speed, 0-100, and how far the handbrake
   actually throws the car sideways. */
import { makeCar, stepCar } from "../src/sim.js";
import { curatedTracks as ct } from "../src/tracks.js";
const tr = ct()[0];
const openRoad = { ...tr, halfWidth: 1e6 };   // no walls, just a straight
const car = makeCar(tr);
let t100 = null;
for (let k = 0; k < 120 * 12; k++) {
  stepCar(car, { steer: 0, thr: 1, hb: false }, openRoad, SIM_DT);
  const sp = Math.hypot(car.vx, car.vy);
  if (t100 == null && sp > 200) t100 = k * SIM_DT;    // 0-200 units/s
}
console.log(`\nacceleration`);
console.log(`  top speed     ${(Math.hypot(car.vx, car.vy) * 0.5).toFixed(0)} km/h displayed after 12s`);
console.log(`  0-100         ${t100 ? t100.toFixed(2) + "s" : "never"}`);

const car2 = makeCar(tr);
for (let k = 0; k < 120 * 6; k++) stepCar(car2, { steer: 0, thr: 1, hb: false }, openRoad, SIM_DT);
let maxSlip = 0;
for (let k = 0; k < 120 * 2; k++) {
  stepCar(car2, { steer: 1, thr: 0.4, hb: true }, openRoad, SIM_DT);
  maxSlip = Math.max(maxSlip, car2.slip);
}
console.log(`  handbrake     peak drift angle ${(maxSlip * 180 / Math.PI).toFixed(0)} deg`);
