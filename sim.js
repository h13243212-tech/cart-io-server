/* ==================================================================
   CART.IO — SHARED SIMULATION
   ------------------------------------------------------------------
   This file contains the RULES of the game and nothing else.

     - no canvas
     - no DOM
     - no requestAnimationFrame
     - no browser globals

   Why that matters: this exact file runs on the SERVER as the single
   source of truth, in the browser for offline practice, and inside
   `node test-sim.js` for the test suite. One implementation, three
   places. If a rule only exists on the client, players can cheat it;
   if it only exists on the server, you can't test it.

   Every function here is pure or mutates only plain objects passed in.
   Every time-based value is expressed in SECONDS and multiplied by dt,
   which is what keeps physics identical at 60Hz and 165Hz.
   ================================================================== */

// ------------------------------------------------------------------
// MAP
//   '#' wall   'S' shelf (solid)   '.' floor   'L' loading bay floor
//   'o' light loot   'O' heavy loot   'E' electronics loot
//   'V' van    'M' main door    'B' loading bay door
// ------------------------------------------------------------------
export const TILE = 60;

export const MAP = [
  "########################",
  "#SSEEEEELLLLLLLLLLLLLLB#",
  "#SSEEEEELLLLLLLLLLLLL..#",
  "#SS.....LLLLLLLLLLLLL.V#",
  "#SS....................#",
  "#........SSSSSS........#",
  "#...oo...SSSSSS...oo...#",
  "#........SSSSSS........#",
  "#......................#",
  "#..SSSS..........SSSS..#",
  "#..SSSS....OO....SSSS..#",
  "#..........OO..........#",
  "#......................#",
  "#..SSSS..........SSSS..#",
  "#..SSSS...oooo...SSSS..#",
  "#......................#",
  "#.......SSSSSSSS.......#",
  "#..oo...SSSSSSSS...oo..#",
  "#.......SSSSSSSS.......#",
  "#......................#",
  "#..SSSS..........SSSS..#",
  "#..SSSS....oo....SSSS..#",
  "#......................#",
  "#.oo................oo.#",
  "##########M#############",
];

export const COLS = MAP[0].length;
export const ROWS = MAP.length;
export const WORLD = { w: COLS * TILE, h: ROWS * TILE };

export const tileAt = (c, r) => (r < 0 || c < 0 || r >= ROWS || c >= COLS) ? "#" : MAP[r][c];
export const solidAt = (c, r) => { const t = tileAt(c, r); return t === "#" || t === "S"; };
export const solidAtPx = (x, y) => solidAt(Math.floor(x / TILE), Math.floor(y / TILE));
export const px = c => c * TILE + TILE / 2;
export const py = r => r * TILE + TILE / 2;

// Derive the interesting coordinates once, at module load.
export const SPAWN = { light: [], heavy: [], electronics: [] };
export let VAN = { x: 0, y: 0 };
export let MAIN_DOOR = { x: WORLD.w / 2, y: WORLD.h - 100 };
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const t = MAP[r][c];
    if (t === "o") SPAWN.light.push({ x: px(c), y: py(r) });
    else if (t === "O") SPAWN.heavy.push({ x: px(c), y: py(r) });
    else if (t === "E") SPAWN.electronics.push({ x: px(c), y: py(r) });
    else if (t === "V") VAN = { x: px(c), y: py(r) };
    else if (t === "M") MAIN_DOOR = { x: px(c), y: py(r - 1) };
  }
}

// ------------------------------------------------------------------
// TUNING
// ------------------------------------------------------------------
export const TUNING = {
  carryK: 1.10,          // THE number: how much weight slows you down
  thief: {
    r: 13, topSpeed: 235, accel: 1500, friction: 11,
    dodgePower: 2.7, dodgeTime: 0.20, dodgeCooldown: 1.5,
    respawnTime: 4,
  },
  guard: {
    r: 26, topSpeed: 195, chaseSpeed: 250, accel: 900,
    sightRange: 340, loseRange: 480,
    stompRange: 96, stompWindup: 0.60, stompCooldown: 1.6, stompRadius: 78,
    sweepRange: 130, sweepCooldown: 3.2,
  },
  round: { seconds: 90, vanStarts: 40, vanLeaves: 15, bankRadius: 62 },
  lobby: { maxPlayers: 12, minPlayers: 2, tickRate: 20 },
};

// ------------------------------------------------------------------
// ITEMS
// ------------------------------------------------------------------
export const ITEM_TYPES = [
  { id: 0, name: "Candy bar",  weight: 0.05, lift: 0.00, value: 4,   w: 16, h: 8  },
  { id: 1, name: "Lipstick",   weight: 0.10, lift: 0.00, value: 18,  w: 8,  h: 20 },
  { id: 2, name: "Sneakers",   weight: 0.30, lift: 0.10, value: 45,  w: 26, h: 14 },
  { id: 3, name: "Console",    weight: 0.70, lift: 0.22, value: 95,  w: 30, h: 22 },
  { id: 4, name: "Flatscreen", weight: 1.50, lift: 0.40, value: 180, w: 46, h: 30 },
  { id: 5, name: "Fridge",     weight: 3.00, lift: 0.70, value: 400, w: 34, h: 46 },
];

/**
 * THE MOST IMPORTANT FUNCTION IN THE PROJECT.
 * weight -> speed multiplier in (0, 1].
 * Asymptotic, so nothing is ever literally uncarryable; only the cost changes.
 */
export const carryMultiplier = (weight, k = TUNING.carryK) => 1 / (1 + weight * k);

export function rollItems(rand = Math.random) {
  const out = [];
  let id = 0;
  const push = (s, def) => out.push({
    id: id++, type: def.id, x: s.x, y: s.y, carried: false, by: null,
  });
  for (const s of SPAWN.light) {
    const r = rand();
    push(s, r < 0.5 ? ITEM_TYPES[0] : r < 0.8 ? ITEM_TYPES[1] : ITEM_TYPES[2]);
  }
  for (const s of SPAWN.heavy) push(s, rand() < 0.5 ? ITEM_TYPES[3] : ITEM_TYPES[4]);
  for (const s of SPAWN.electronics) push(s, rand() < 0.35 ? ITEM_TYPES[5] : ITEM_TYPES[4]);
  return out;
}

// ------------------------------------------------------------------
// COLLISION — circle vs solid tiles, axis-separated for wall sliding
// ------------------------------------------------------------------
export function resolveAxis(e, axis) {
  const c0 = Math.floor((e.x - e.r) / TILE), c1 = Math.floor((e.x + e.r) / TILE);
  const r0 = Math.floor((e.y - e.r) / TILE), r1 = Math.floor((e.y + e.r) / TILE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!solidAt(c, r)) continue;
      const rx = c * TILE, ry = r * TILE;
      const nx = Math.max(rx, Math.min(e.x, rx + TILE));
      const ny = Math.max(ry, Math.min(e.y, ry + TILE));
      const dx = e.x - nx, dy = e.y - ny;
      const d2 = dx * dx + dy * dy;
      if (d2 >= e.r * e.r) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2), push = e.r - d;
        if (axis === "x") e.x += (dx / d) * push; else e.y += (dy / d) * push;
      } else {
        if (axis === "x") e.x = e.x < rx + TILE / 2 ? rx - e.r : rx + TILE + e.r;
        else e.y = e.y < ry + TILE / 2 ? ry - e.r : ry + TILE + e.r;
      }
    }
  }
}
export function moveEntity(e, dx, dy) {
  e.x += dx; resolveAxis(e, "x");
  e.y += dy; resolveAxis(e, "y");
}

// ------------------------------------------------------------------
// LINE OF SIGHT — DDA march over the tile grid
// ------------------------------------------------------------------
export function hasLOS(x0, y0, x1, y1) {
  let c = Math.floor(x0 / TILE), r = Math.floor(y0 / TILE);
  const cc = Math.floor(x1 / TILE), rr = Math.floor(y1 / TILE);
  const dx = x1 - x0, dy = y1 - y0;
  const stepC = dx > 0 ? 1 : -1, stepR = dy > 0 ? 1 : -1;
  const tDeltaC = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
  const tDeltaR = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
  let tMaxC = dx !== 0 ? ((dx > 0 ? (c + 1) * TILE - x0 : x0 - c * TILE) / Math.abs(dx)) : Infinity;
  let tMaxR = dy !== 0 ? ((dy > 0 ? (r + 1) * TILE - y0 : y0 - r * TILE) / Math.abs(dy)) : Infinity;
  let guard = 0;
  while (guard++ < 400) {
    if (c === cc && r === rr) return true;
    if (tMaxC < tMaxR) { c += stepC; tMaxC += tDeltaC; } else { r += stepR; tMaxR += tDeltaR; }
    if (solidAt(c, r)) return false;
  }
  return false;
}

// ------------------------------------------------------------------
// A* PATHFINDING (bots)
// ------------------------------------------------------------------
export function findPath(sx, sy, tx, ty) {
  const sc = Math.floor(sx / TILE), sr = Math.floor(sy / TILE);
  const tc = Math.floor(tx / TILE), tr = Math.floor(ty / TILE);
  if (sc === tc && sr === tr) return [];
  if (solidAt(tc, tr)) return [];
  const key = (c, r) => r * COLS + c;
  const open = [{ c: sc, r: sr, g: 0, f: 0 }];
  const came = new Map(), gScore = new Map([[key(sc, sr), 0]]);
  const h = (c, r) => {
    const dc = Math.abs(c - tc), dr = Math.abs(r - tr);
    return (dc + dr) + (Math.SQRT2 - 2) * Math.min(dc, dr);
  };
  let iter = 0;
  while (open.length && iter++ < 4000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.c === tc && cur.r === tr) {
      const path = [];
      let k = key(cur.c, cur.r);
      while (came.has(k)) { path.push({ x: px(k % COLS), y: py(Math.floor(k / COLS)) }); k = came.get(k); }
      return path.reverse();
    }
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dc && !dr) continue;
      const nc = cur.c + dc, nr = cur.r + dr;
      if (solidAt(nc, nr)) continue;
      if (dc && dr && (solidAt(cur.c + dc, cur.r) || solidAt(cur.c, cur.r + dr))) continue;
      const ng = cur.g + ((dc && dr) ? Math.SQRT2 : 1);
      const kk = key(nc, nr);
      if (ng < (gScore.get(kk) ?? Infinity)) {
        gScore.set(kk, ng); came.set(kk, key(cur.c, cur.r));
        open.push({ c: nc, r: nr, g: ng, f: ng + h(nc, nr) });
      }
    }
  }
  return [];
}

// ------------------------------------------------------------------
// ENTITIES
// ------------------------------------------------------------------
export const BOT_NAMES = ["kevbot","noob_slayer","xX_maya_Xx","toast","grumble","pip","zer0",
  "munch","sneaks","bloop","rada","fig","otto","wex","nubi","clank","dizzy","momo"];

let uid = 0;
export const nextId = () => ++uid;

export function makeThief(name, isBot) {
  const T = TUNING.thief;
  return {
    id: nextId(), name, isBot, r: T.r,
    x: MAIN_DOOR.x + (Math.random() - 0.5) * 40,
    y: MAIN_DOOR.y + (Math.random() - 0.5) * 20,
    vx: 0, vy: 0, fx: 0, fy: -1,
    carryingId: null, liftingId: null, liftT: 0,
    dodgeT: 0, dodgeCd: 0, wobble: 0,
    cash: 0, banked: 0, busts: 0, aliveTime: 0, dead: 0,
    input: { x: 0, y: 0, grab: false, drop: false, dodge: false },
    path: [], repath: 0, panic: 0, targetId: null,
  };
}

export function makeGuard() {
  const G = TUNING.guard;
  return {
    r: G.r, x: px(12), y: py(10), vx: 0, vy: 0,
    patrol: [ {x: px(20), y: py(2)}, {x: px(4), y: py(2)}, {x: px(4), y: py(21)},
              {x: px(20), y: py(21)}, {x: px(12), y: py(11)} ],
    pi: 0, state: "patrol", targetId: null,
    stompT: 0, stompX: 0, stompY: 0, stompCd: 0, sweepCd: 0,
    busts: 0, recovered: 0,
  };
}

export const carriedItem = (t, world) => t.carryingId == null ? null : world.items[t.carryingId] ?? null;
export const speedMul = (t, world) => {
  const it = carriedItem(t, world);
  return it ? carryMultiplier(ITEM_TYPES[it.type].weight) : 1;
};

// ------------------------------------------------------------------
// RULES — shared between server and client
// ------------------------------------------------------------------
export function startGrab(t, world, item) {
  if (!item || item.carried) return;
  if (ITEM_TYPES[item.type].lift <= 0) {
    t.carryingId = item.id; item.carried = true; item.by = t.id;
  } else {
    t.liftingId = item.id; t.liftT = 0;
  }
}

export function dropItem(t, world) {
  const it = carriedItem(t, world);
  if (!it) return;
  it.carried = false; it.by = null;
  it.x = t.x + t.fx * 32; it.y = t.y + t.fy * 32;
  t.carryingId = null;
}

export function doDodge(t) {
  if (t.dodgeCd > 0 || t.liftingId != null) return false;
  const T = TUNING.thief;
  t.dodgeT = T.dodgeTime;
  t.dodgeCd = T.dodgeCooldown;
  const l = Math.hypot(t.input.x, t.input.y);
  const dx = l > 0 ? t.input.x / l : t.fx;
  const dy = l > 0 ? t.input.y / l : t.fy;
  t.vx = dx * T.topSpeed * T.dodgePower;
  t.vy = dy * T.topSpeed * T.dodgePower;
  return true;
}

export function moveThief(t, world, dt, ix, iy) {
  const T = TUNING.thief;
  const mul = speedMul(t, world);
  const maxSpeed = T.topSpeed * mul;
  const accel = T.accel * (0.35 + 0.65 * mul);
  const fric = T.friction * (0.25 + 0.75 * mul);

  if (t.dodgeT > 0) {
    t.dodgeT -= dt;
    moveEntity(t, t.vx * dt, t.vy * dt);
    return;
  }
  const l = Math.hypot(ix, iy);
  if (l > 0) {
    ix /= l; iy /= l;
    t.vx += ix * accel * dt; t.vy += iy * accel * dt;
    t.fx = ix; t.fy = iy;
  } else {
    const decay = Math.exp(-fric * dt);
    t.vx *= decay; t.vy *= decay;
  }
  const sp = Math.hypot(t.vx, t.vy);
  if (sp > maxSpeed) { t.vx = t.vx / sp * maxSpeed; t.vy = t.vy / sp * maxSpeed; }
  moveEntity(t, t.vx * dt, t.vy * dt);
  if (t.carryingId != null) t.wobble += dt * (6 + 10 * ITEM_TYPES[world.items[t.carryingId].type].weight);
}

/** BANKING — a game rule, not a player action. Runs on the server. */
export function tryBank(t, world) {
  const it = carriedItem(t, world);
  if (t.dead > 0 || !it || world.vanGone) return false;
  if (Math.hypot(t.x - VAN.x, t.y - VAN.y) >= TUNING.round.bankRadius) return false;
  t.cash += ITEM_TYPES[it.type].value;
  t.banked++;
  it.carried = false; it.by = null;
  t.carryingId = null;
  return true;
}

/** BUSTING — a game rule. Runs on the server. */
export function bust(t, world, guard) {
  const it = carriedItem(t, world);
  const lost = it ? ITEM_TYPES[it.type].value : 0;
  if (it) { it.carried = false; it.by = null; }
  t.carryingId = null; t.liftingId = null;
  t.dead = TUNING.thief.respawnTime;
  t.busts++; t.vx = 0; t.vy = 0;
  if (guard) { guard.busts++; guard.recovered += lost; }
  return lost;
}

export function respawn(t) {
  t.x = MAIN_DOOR.x; t.y = MAIN_DOOR.y; t.vx = 0; t.vy = 0;
  t.carryingId = null; t.liftingId = null;
}

// ------------------------------------------------------------------
// GUARD AI
// ------------------------------------------------------------------
function nearestThief(world, g) {
  const G = TUNING.guard;
  let best = null, bd = Infinity;
  for (const t of world.thieves) {
    if (t.dead > 0) continue;
    const d = Math.hypot(t.x - g.x, t.y - g.y);
    if (d > (g.state === "chase" ? G.loseRange : G.sightRange)) continue;
    if (!hasLOS(g.x, g.y, t.x, t.y)) continue;
    const greed = carriedItem(t, world) ? 1 + ITEM_TYPES[world.items[t.carryingId].type].weight * 0.35 : 1;
    const eff = d / greed;
    if (eff < bd) { bd = eff; best = t; }
  }
  return best;
}

export function updateGuard(world, g, dt) {
  const G = TUNING.guard;
  if (g.stompCd > 0) g.stompCd -= dt;
  if (g.sweepCd > 0) g.sweepCd -= dt;

  const seen = nearestThief(world, g);
  if (seen) { g.targetId = seen.id; g.state = "chase"; }
  else {
    const tgt = world.thieves.find(t => t.id === g.targetId);
    if (g.state === "chase" && (!tgt || tgt.dead > 0 ||
        Math.hypot(tgt.x - g.x, tgt.y - g.y) > G.loseRange ||
        !hasLOS(g.x, g.y, tgt.x, tgt.y))) { g.state = "patrol"; g.targetId = null; }
  }

  if (g.stompT > 0) {
    g.stompT -= dt;
    if (g.stompT <= 0) {
      for (const t of world.thieves) {
        if (t.dead > 0) continue;
        if (Math.hypot(t.x - g.stompX, t.y - g.stompY) <= G.stompRadius + t.r) bust(t, world, g);
      }
    }
    return;
  }

  const target = world.thieves.find(t => t.id === g.targetId) || null;
  let ix = 0, iy = 0;
  if (g.state === "chase" && target) {
    const dx = target.x - g.x, dy = target.y - g.y;
    const d = Math.hypot(dx, dy) || 1;
    ix = dx / d; iy = dy / d;
    if (d < G.stompRange && g.stompCd <= 0) {
      g.stompT = G.stompWindup;
      g.stompX = target.x; g.stompY = target.y;   // telegraphed at their CURRENT spot
      g.stompCd = G.stompCooldown;
      return;
    }
    if (d < G.sweepRange && g.sweepCd <= 0 && target.carryingId != null) {
      g.sweepCd = G.sweepCooldown;
      dropItem(target, world);
    }
  } else {
    const wp = g.patrol[g.pi];
    const dx = wp.x - g.x, dy = wp.y - g.y;
    const d = Math.hypot(dx, dy);
    if (d < 20) g.pi = (g.pi + 1) % g.patrol.length;
    else { ix = dx / d; iy = dy / d; }
  }

  const speed = g.state === "chase" ? G.chaseSpeed : G.topSpeed;
  g.vx += ix * G.accel * dt; g.vy += iy * G.accel * dt;
  const sp = Math.hypot(g.vx, g.vy);
  if (sp > speed) { g.vx = g.vx / sp * speed; g.vy = g.vy / sp * speed; }
  if (!ix && !iy) { const dec = Math.exp(-9 * dt); g.vx *= dec; g.vy *= dec; }
  moveEntity(g, g.vx * dt, g.vy * dt);
}

// ------------------------------------------------------------------
// BOT BRAIN
// ------------------------------------------------------------------
function botScore(b, world, it) {
  const def = ITEM_TYPES[it.type];
  const d = Math.hypot(b.x - it.x, b.y - it.y) + 1;
  const risk = 1 / carryMultiplier(def.weight);
  const distToVan = Math.hypot(it.x - VAN.x, it.y - VAN.y);
  return def.value / (d * 0.6 + distToVan * 0.5) / risk;
}

export function updateBot(world, b, dt) {
  const g = world.guard;
  if (b.dead > 0) { b.dead -= dt; if (b.dead <= 0) respawn(b); return; }

  const gd = Math.hypot(g.x - b.x, g.y - b.y);
  const threatened = gd < 230 && hasLOS(g.x, g.y, b.x, b.y);
  b.panic = threatened ? 1.2 : Math.max(0, b.panic - dt);

  if (b.panic > 0) {
    const it = carriedItem(b, world);
    if (it && ITEM_TYPES[it.type].weight > 1.0 && gd < 150) dropItem(b, world);
    const dx = b.x - g.x, dy = b.y - g.y, d = Math.hypot(dx, dy) || 1;
    b.input.x = dx / d; b.input.y = dy / d;
    moveThief(b, world, dt, b.input.x, b.input.y);
    if (gd < 120 && b.dodgeCd <= 0) doDodge(b);
    b.repath = 0;
    return;
  }

  if (b.carryingId != null) {
    b.repath -= dt;
    if (b.repath <= 0 || b.path.length === 0) { b.path = findPath(b.x, b.y, VAN.x, VAN.y); b.repath = 0.5; }
    if (b.path.length && Math.hypot(b.path[0].x - b.x, b.path[0].y - b.y) < 22) b.path.shift();
    const n = b.path[0] || VAN;
    moveThief(b, world, dt, n.x - b.x, n.y - b.y);
    tryBank(b, world);
    return;
  }

  let target = b.targetId == null ? null : world.items[b.targetId];
  if (!target || target.carried) {
    let best = null, bs = -Infinity;
    for (const it of world.items) {
      if (it.carried) continue;
      const s = botScore(b, world, it);
      if (s > bs) { bs = s; best = it; }
    }
    target = best;
    b.targetId = best ? best.id : null;
    b.path = best ? findPath(b.x, b.y, best.x, best.y) : [];
    b.repath = 0.5;
  }
  if (!target) { moveThief(b, world, dt, 0, 0); return; }

  b.repath -= dt;
  if (b.repath <= 0) { b.path = findPath(b.x, b.y, target.x, target.y); b.repath = 0.5; }
  if (b.path.length && Math.hypot(b.path[0].x - b.x, b.path[0].y - b.y) < 22) b.path.shift();
  const n = b.path[0] || target;
  moveThief(b, world, dt, n.x - b.x, n.y - b.y);

  const d = Math.hypot(target.x - b.x, target.y - b.y);
  if (d < 34 && !target.carried) {
    if (b.liftingId === target.id) {
      b.liftT += dt;
      if (b.liftT >= ITEM_TYPES[target.type].lift) {
        b.carryingId = target.id; target.carried = true; target.by = b.id;
        b.liftingId = null; b.targetId = null;
      }
    } else startGrab(b, world, target);
  } else if (b.liftingId != null) {
    const li = world.items[b.liftingId];
    if (!li || Math.hypot(li.x - b.x, li.y - b.y) > 48) { b.liftingId = null; b.liftT = 0; }
  }
}

// ------------------------------------------------------------------
// WORLD — the authoritative state container
// ------------------------------------------------------------------
export function createWorld(opts = {}) {
  const bots = opts.bots ?? 7;
  const world = {
    items: rollItems(opts.rand),
    thieves: [],
    guard: makeGuard(),
    timeLeft: TUNING.round.seconds,
    vanGone: false,
    vanLeaving: false,
    over: false,
    events: [],           // transient events for this tick (busts, banks) — sent to clients
  };
  for (let i = 0; i < bots; i++) world.thieves.push(makeThief(BOT_NAMES[i % BOT_NAMES.length], true));
  return world;
}

/** Add a human player. Returns the thief. */
export function joinWorld(world, name) {
  const t = makeThief(name || "player", false);
  world.thieves.push(t);
  return t;
}

export function leaveWorld(world, thiefId) {
  const i = world.thieves.findIndex(t => t.id === thiefId);
  if (i < 0) return;
  const t = world.thieves[i];
  const it = carriedItem(t, world);
  if (it) { it.carried = false; it.by = null; }
  world.thieves.splice(i, 1);
}

/**
 * ONE AUTHORITATIVE TICK. The server calls this at TUNING.lobby.tickRate.
 * Everything that can change the game happens in here.
 */
export function tickWorld(world, dt) {
  world.events.length = 0;
  if (world.over) return world;

  const R = TUNING.round;
  world.timeLeft -= dt;
  if (world.timeLeft <= R.vanStarts) world.vanLeaving = true;
  if (world.timeLeft <= R.vanLeaves && !world.vanGone) {
    world.vanGone = true;
    // doors slam — anything still held is LOST
    for (const t of world.thieves) {
      const it = carriedItem(t, world);
      if (it) { it.carried = false; it.by = null; }
      t.carryingId = null; t.liftingId = null;
    }
    world.events.push({ t: "vanGone" });
  }

  for (const t of world.thieves) {
    if (t.isBot) { updateBot(world, t, dt); continue; }
    if (t.dodgeCd > 0) t.dodgeCd -= dt;
    if (t.dead > 0) {
      t.dead -= dt;
      if (t.dead <= 0) { respawn(t); world.events.push({ t: "respawn", id: t.id }); }
      continue;
    }
    t.aliveTime += dt;
    if (t.input.dodge) doDodge(t);

    if (t.liftingId != null) {
      const li = world.items[t.liftingId];
      if (!li || li.carried || !t.input.grab || Math.hypot(t.x - li.x, t.y - li.y) > 70) {
        t.liftingId = null; t.liftT = 0;
      } else {
        t.liftT += dt;
        if (t.liftT >= ITEM_TYPES[li.type].lift) {
          t.carryingId = li.id; li.carried = true; li.by = t.id;
          t.liftingId = null; t.liftT = 0;
        }
      }
    } else if (t.input.grab && t.carryingId == null) {
      let best = null, bd = 52;
      for (const it of world.items) {
        if (it.carried) continue;
        const d = Math.hypot(t.x - it.x, t.y - it.y);
        if (d < bd) { bd = d; best = it; }
      }
      if (best) startGrab(t, world, best);
    }
    if (t.input.drop) { dropItem(t, world); t.input.drop = false; }

    moveThief(t, world, dt, t.input.x, t.input.y);
    if (tryBank(t, world)) world.events.push({ t: "bank", id: t.id, cash: t.cash });
  }

  const before = world.guard.busts;
  updateGuard(world, world.guard, dt);
  if (world.guard.busts > before) {
    world.events.push({ t: "bust", by: world.guard.busts });
  }

  if (world.timeLeft <= 0) { world.timeLeft = 0; world.over = true; world.events.push({ t: "over" }); }
  return world;
}

/** Compact snapshot for the network. Only what the client needs to draw. */
export function snapshot(world) {
  return {
    tl: Math.max(0, world.timeLeft),
    vg: world.vanGone ? 1 : 0,
    vl: world.vanLeaving ? 1 : 0,
    ov: world.over ? 1 : 0,
    g: (() => { const g = world.guard; return {
      x: Math.round(g.x), y: Math.round(g.y), s: g.state === "chase" ? 1 : 0,
      st: Math.round(g.stompT * 100), sx: Math.round(g.stompX), sy: Math.round(g.stompY),
      b: g.busts, rc: g.recovered,
    }; })(),
    t: world.thieves.map(t => ({
      i: t.id, n: t.name, x: Math.round(t.x), y: Math.round(t.y),
      c: t.carryingId == null ? -1 : world.items[t.carryingId].type,
      d: t.dead > 0 ? Math.round(t.dead * 10) : 0,
      m: Math.round(speedMul(t, world) * 100),
      $: t.cash, k: t.banked, bu: t.busts, bot: t.isBot ? 1 : 0,
      fx: Math.round(t.fx * 10) / 10, fy: Math.round(t.fy * 10) / 10,
      lf: t.liftingId != null ? Math.round(t.liftT * 100) : -1,
    })),
    it: world.items.filter(i => !i.carried).map(i => ({ i: i.id, y: i.type, x: Math.round(i.x), z: Math.round(i.y) })),
  };
}
