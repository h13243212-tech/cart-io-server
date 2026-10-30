/* ==================================================================
   MAIN — glue: state machine, fixed-timestep loop, HUD, persistence.

   THE LOOP IS A FIXED-TIMESTEP ACCUMULATOR, and that is a requirement,
   not a preference. CrazyGames' technical rules say the physics must
   behave the same at 144 Hz and 165 Hz; variable-dt physics does not.
   Here the sim always advances in exact SIM_DT steps and the display
   refresh rate only decides how many steps run per frame. A 165 Hz
   monitor and a 60 Hz monitor produce byte-identical car behaviour.
   ================================================================== */
import { curatedTracks, trackById } from "./tracks.js";
import { createRun, stepRun, SIM_DT, TUNING } from "./sim.js";
import { Renderer, bakeTrack } from "./render.js";
import { Input } from "./input.js";
import { sdk } from "./sdk.js";

const canvas = document.getElementById("c");
const el = {
  lap: document.getElementById("lap"),
  time: document.getElementById("time"),
  best: document.getElementById("best"),
  delta: document.getElementById("delta"),
  speed: document.getElementById("speed"),
  surface: document.getElementById("surface"),
  banner: document.getElementById("banner"),
  menu: document.getElementById("menu"),
  result: document.getElementById("result"),
  tracks: document.getElementById("tracks"),
  scores: document.getElementById("scores"),
  newbest: document.getElementById("newbest"),
  menuCta: document.getElementById("menuCta"),
  touch: document.getElementById("touch"),
};

const KEY_BEST = id => `slipstream.best.${id}`;
const KEY_GHOST = id => `slipstream.ghost.${id}`;

const tracks = curatedTracks();
const renderer = new Renderer(canvas);
const input = new Input(window);
input.bindTouch(el.touch);

let trackIndex = 0;
let tr = tracks[trackIndex];
let baked = bakeTrack(tr);
let run = null;
let state = "menu";          // menu | racing | result
let steer = 0;               // analogue steering, ramped from digital keys
let cmd = { steer: 0, thr: 0, hb: false };
let bests = {};
let ghosts = {};
let bannerTimer = 0;
let lastLapSeen = -1;
let ghostSample = 0;

/* ------------------------------------------------------------------
   PERSISTENCE
   ------------------------------------------------------------------ */
async function loadProgress() {
  for (const t of tracks) {
    const b = await sdk.load(KEY_BEST(t.id));
    if (b) bests[t.id] = Number(b);
    const g = await sdk.load(KEY_GHOST(t.id));
    if (g) {
      try { ghosts[t.id] = JSON.parse(g); } catch { /* corrupt, ignore */ }
    }
  }
  buildTrackCards();
}

/* ------------------------------------------------------------------
   MENU
   ------------------------------------------------------------------ */
function buildTrackCards() {
  el.tracks.innerHTML = "";
  tracks.forEach((t, i) => {
    const card = document.createElement("div");
    card.className = "card" + (i === trackIndex ? " sel" : "");
    card.innerHTML = `<b>${t.name}</b><span>${
      bests[t.id] ? "best " + fmt(bests[t.id]) : "no time yet"
    }</span>`;
    card.onclick = (e) => {
      e.stopPropagation();
      trackIndex = i;
      tr = tracks[i];
      baked = bakeTrack(tr);
      _idle = null;                     // menu car must move to the new circuit
      renderer.reset(tr, baked);
      buildTrackCards();
    };
    el.tracks.appendChild(card);
  });
}

function showMenu() {
  state = "menu";
  sdk.gameplayStop();
  el.menu.classList.add("on");
  el.result.classList.remove("on");
  el.touch.classList.remove("on");
  el.banner.style.opacity = 0;
  buildTrackCards();
}

/* ------------------------------------------------------------------
   RUNS
   ------------------------------------------------------------------ */
function startRun() {
  el.menu.classList.remove("on");
  el.result.classList.remove("on");
  if (input.autoThrottle) el.touch.classList.add("on");
  run = createRun(tr, { ghost: ghosts[tr.id] ?? null });
  renderer.reset(tr, baked);
  steer = 0;
  cmd = { steer: 0, thr: 0, hb: false };
  state = "racing";
  lastLapSeen = 0;
  banner("3", 0.9);
  sdk.gameplayStart();
}

async function finishRun() {
  state = "result";
  sdk.gameplayStop();

  const laps = run.lapTimes;
  const best = run.best;
  const prev = bests[tr.id];
  const isNew = best != null && (prev == null || best < prev);

  if (isNew) {
    bests[tr.id] = best;
    ghosts[tr.id] = run.ghost;
    sdk.save(KEY_BEST(tr.id), String(best));
    sdk.save(KEY_GHOST(tr.id), JSON.stringify(run.ghost ?? []));
  }

  el.newbest.textContent = isNew ? "new best lap" : "";
  el.result.querySelector("#resultTitle").textContent =
    isNew ? "FASTER" : "LAP DONE";
  el.scores.innerHTML = laps
    .map((t, i) => {
      const isB = Math.abs(t - best) < 1e-6;
      return `<div><span>Lap ${i + 1}</span><span${isB ? ' style="color:var(--hot);font-weight:700"' : ""}>${fmt(t)}</span></div>`;
    })
    .join("") + `<div style="margin-top:8px"><span>Best</span><span>${fmt(best)}</span></div>`;

  el.touch.classList.remove("on");
  el.result.classList.add("on");
}

/* ------------------------------------------------------------------
   BANNER
   ------------------------------------------------------------------ */
function banner(text, seconds) {
  el.banner.textContent = text;
  el.banner.style.opacity = 1;
  bannerTimer = seconds;
}

/* ------------------------------------------------------------------
   TICK + FRAME
   ------------------------------------------------------------------ */
function tick() {
  // ramp digital steering into an analogue value, per sim step, so the
  // feel is identical at any refresh rate
  const target = input.steering;
  const rate = target === 0 ? 10 : 7.5;
  const step = rate * SIM_DT;
  steer += Math.max(-step, Math.min(step, target - steer));

  cmd = { steer, thr: input.throttle, hb: input.handbrake };

  const beforeLap = run.lap;
  const wasCountdown = run.countdown > 0;
  stepRun(run, cmd);

  if (wasCountdown && run.countdown <= 0) banner("GO", 0.55);
  if (run.lap > beforeLap) {
    const t = run.lapTimes[run.lapTimes.length - 1];
    banner(fmt(t), 1.1);
  }
  if (run.finished) finishRun();
}

let last = performance.now();
let acc = 0;

function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (state === "racing") {
    acc += dtReal;
    let steps = 0;
    // cap the catch-up so a stalled tab cannot fast-forward the car
    while (acc >= SIM_DT && steps < 10) {
      tick();
      acc -= SIM_DT;
      steps++;
      if (state !== "racing") break;
    }
    if (steps === 10) acc = 0;
    if (run.countdown > 0) {
      const n = Math.ceil(run.countdown);
      if (n <= 3 && run.countdown < 2.6) el.banner.textContent = String(n);
    }
  }

  if (bannerTimer > 0) {
    bannerTimer -= dtReal;
    if (bannerTimer <= 0) el.banner.style.opacity = 0;
  }

  renderer.draw(run ?? idleRun(), cmd, dtReal, state);
  updateHud(dtReal);
  requestAnimationFrame(frame);
}

let _idle = null;
function idleRun() {
  if (!_idle) {
    _idle = createRun(tr, {});
    _idle.countdown = 0;
  }
  return _idle;
}

function fmt(t) {
  if (t == null) return "—";
  return t.toFixed(2);
}

function updateHud() {
  if (state === "menu" && _idle) {
    el.time.textContent = "0.00";
  }
  if (!run || state === "menu") { el.speed.textContent = "0"; return; }

  const speed = Math.hypot(run.car.vx, run.car.vy);
  el.speed.textContent = String(Math.round(speed * 0.5));
  el.lap.textContent = `${Math.min(run.laps, run.lap + 1)} / ${run.laps}`;
  el.time.textContent = fmt(run.lapT);
  el.best.textContent = fmt(bests[tr.id] ?? run.best);
  el.surface.textContent = run.car.surface === "gravel" ? "OFF LINE" : "";
  el.surface.style.color = "var(--hot)";

  // rough delta to the ghost, in seconds
  const g = run.ghost;
  if (g && g.length && state === "racing") {
    const i = Math.min(g.length - 1, Math.floor(run.lapT * 30));
    const f = g[i];
    if (f && typeof f.d === "number") {
      const denom = Math.max(140, speed);
      const d = (run.dist - f.d) / denom;
      if (Math.abs(d) < 30) {
        el.delta.textContent = (d <= 0 ? "−" : "+") + Math.abs(d).toFixed(2);
        el.delta.className = "mid" + (d > 0 ? " slow" : "");
      } else {
        el.delta.textContent = "";
      }
    }
  } else {
    el.delta.textContent = "";
  }
}

/* ------------------------------------------------------------------
   EVENTS
   ------------------------------------------------------------------ */
function primaryAction() {
  if (state === "menu" || state === "result") {
    if (state === "result") sdk.ad();     // midgame ad between runs, never during
    startRun();
  }
}

window.addEventListener("keydown", e => {
  if (e.code === "Space" || e.code === "Enter" || e.code === "ArrowUp") {
    if (state !== "racing") { e.preventDefault(); primaryAction(); }
  }
  if (e.code === "KeyR" && state === "racing") { startRun(); }
});

for (const s of [el.menu, el.result]) s.addEventListener("click", primaryAction);

window.addEventListener("resize", () => renderer.resize());
window.addEventListener("orientationchange", () => setTimeout(() => renderer.resize(), 120));

/* ------------------------------------------------------------------
   BOOT
   ------------------------------------------------------------------ */
sdk.init();
loadProgress();
renderer.reset(tr, baked);
requestAnimationFrame(frame);
