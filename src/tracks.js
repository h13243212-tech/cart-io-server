/* ==================================================================
   TRACKS — geometry only. No DOM, no canvas.
   ------------------------------------------------------------------
   A track is a closed polyline plus a half-width. The road you drive on
   is "everything within halfWidth of the centerline", so one dataset
   drives rendering (stroke the polyline), collision (distance to it) and
   progress (arc length). Everything here is deterministic, so a seed
   always produces the same circuit and ghosts replay exactly.

   WHY GENERATED, NOT HAND-DRAWN
   The first attempt hand-placed control points and ran them through a
   Catmull-Rom spline. It produced a 14-unit-radius spike — a corner the
   car physically cannot take — because unevenly spaced points make the
   curve overshoot. Centripetal parameterisation fixed the cusps but the
   underlying shape was still a V.

   So: generate a jittered polygon, run it through Chaikin corner-cutting
   until it is provably smooth, resample at uniform arc length, then
   REJECT anything that fails the geometry test below. Curvature is
   bounded by construction and verified per track, which means a bad
   seed simply never becomes a track. It also gives a free daily
   circuit: same seed, same track, everywhere.
   ================================================================== */

/** Deterministic PRNG (mulberry32). Same seed -> same track, forever. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------
   CORNER FILLETING — straights stay straight, corners become arcs.

   Chaikin was the first smoother tried and it was wrong here: it is a
   low-pass filter, so it rounds the shape into an oval and deletes the
   concave detail that makes a circuit interesting. A racing line wants
   long straights joined by well-defined corners, so each polygon vertex
   is replaced by a circular arc of an exact radius and everything in
   between is left alone. The tightest corner on the lap is then known
   exactly, not discovered by measurement.

   Constraint handled here: on a short edge, two neighbouring fillets can
   eat the whole straight and overlap. Tangent lengths are therefore
   clamped edge-by-edge before any arc is generated.
   ------------------------------------------------------------------ */
function filletPath(points, radiusAt) {
  const n = points.length;
  const P = points.map(([x, y]) => ({ x, y }));
  const dirIn = [], dirOut = [], turn = [], tangentLen = [], arcR = [];

  for (let i = 0; i < n; i++) {
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n];
    let ux = b.x - a.x, uy = b.y - a.y;
    let vx = c.x - b.x, vy = c.y - b.y;
    const lu = Math.hypot(ux, uy) || 1, lv = Math.hypot(vx, vy) || 1;
    ux /= lu; uy /= lu; vx /= lv; vy /= lv;
    const cos = Math.max(-1, Math.min(1, ux * vx + uy * vy));
    const theta = Math.acos(cos);          // 0 = dead straight, pi = cusp
    dirIn[i] = [ux, uy]; dirOut[i] = [vx, vy]; turn[i] = theta;
    const R = radiusAt(i);
    tangentLen[i] = theta < 1e-3 ? 0 : R * Math.tan(Math.min(theta, 2.6) / 2);
    arcR[i] = R;
  }

  // shrink paired fillets so they can coexist on a short edge
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const edge = Math.hypot(P[j].x - P[i].x, P[j].y - P[i].y);
    const need = tangentLen[i] + tangentLen[j];
    const room = edge * 0.85;
    if (need > room && need > 1e-6) {
      const k = room / need;
      tangentLen[i] *= k; tangentLen[j] *= k;
      arcR[i] *= k; arcR[j] *= k;
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const b = P[i], t = tangentLen[i];
    if (t < 0.5) { out.push([b.x, b.y]); continue; }   // effectively straight through

    const [ux, uy] = dirIn[i], [vx, vy] = dirOut[i];
    const s0 = [b.x - ux * t, b.y - uy * t];   // tangent point on the incoming edge
    const s1 = [b.x + vx * t, b.y + vy * t];   // tangent point on the outgoing edge

    // The centre lies R away from the tangent point, perpendicular to travel,
    // on whichever side the car turns toward.
    const R = arcR[i];
    const cross = ux * vy - uy * vx;
    const sign = cross > 0 ? 1 : -1;
    const nx = -uy * sign, ny = ux * sign;
    const c = [s0[0] + nx * R, s0[1] + ny * R];

    const a0 = Math.atan2(s0[1] - c[1], s0[0] - c[0]);
    const a1 = Math.atan2(s1[1] - c[1], s1[0] - c[0]);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;

    const steps = Math.max(2, Math.ceil((Math.abs(sweep) * R) / 10));
    for (let k = 0; k <= steps; k++) {
      const ang = a0 + (sweep * k) / steps;
      out.push([c[0] + Math.cos(ang) * R, c[1] + Math.sin(ang) * R]);
    }
  }
  return out;
}

/**
 * Radius per corner. Rhythm matters more than randomness: every third
 * corner is deliberately tight so the lap has something you must brake
 * for, and the rest breathe. Without this every circuit feels like the
 * same oval at a different scale.
 */
function radiusAt(def) {
  const base = def.corner ?? 300;
  const jitter = def.cornerJitter ?? 0.35;
  const seed = (def.seed ?? 1) >>> 0;
  return i => {
    const h = (((seed * 2654435761 + i * 40503) >>> 0) % 1000) / 1000;
    const tight = i % 3 === 2 ? 0.62 : 1;
    return base * tight * (1 - jitter / 2 + h * jitter);
  };
}

/** Resample a closed polyline at uniform arc-length steps. */
function resample(pts, step) {
  const n = pts.length;
  const segs = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, d, at: total });
    total += d;
  }
  const count = Math.max(48, Math.round(total / step));
  const out = [];
  let si = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / count) * total;
    while (si < segs.length - 1 && segs[si].at + segs[si].d < target) si++;
    const s = segs[si];
    const u = s.d > 1e-9 ? (target - s.at) / s.d : 0;
    out.push([s.a[0] + (s.b[0] - s.a[0]) * u, s.a[1] + (s.b[1] - s.a[1]) * u]);
  }
  return out;
}

/**
 * Build the runtime form of a track: uniform samples with tangents and
 * cumulative arc length.
 */
export function buildTrack(def) {
  const step = def.step ?? 10;
  const raw = resample(filletPath(def.points, radiusAt(def)), step);
  const n = raw.length;
  const pts = raw.map(([x, y]) => ({ x, y }));

  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const m = Math.hypot(dx, dy) || 1;
    pts[i].tx = dx / m;
    pts[i].ty = dy / m;
  }
  let len = 0;
  for (let i = 0; i < n; i++) {
    pts[i].s = len;
    const b = pts[(i + 1) % n];
    len += Math.hypot(b.x - pts[i].x, b.y - pts[i].y);
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  return {
    id: def.id, name: def.name, seed: def.seed,
    halfWidth: def.width ?? 130,
    pts, n, len,
    startIndex: 0,
    bounds: { minX, minY, maxX, maxY },
  };
}

/* ------------------------------------------------------------------
   GEOMETRY TEST — the gate every generated track must pass.
   ------------------------------------------------------------------ */
export const GEOMETRY_LIMITS = {
  minRadiusFactor: 1.35,   // tightest corner, as a multiple of halfWidth
  minGapExtra: 100,        // wall thickness left between two bits of road
  minLength: 2600,
  maxLength: 7000,
};

/** Tightest corner on the circuit (radius of the circumscribed circle). */
export function minRadius(tr) {
  const { pts, n } = tr;
  let min = Infinity, at = null;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 2 + n) % n], b = pts[i], c = pts[(i + 2) % n];
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (area2 < 1e-6) continue;
    const R = (ab * bc * ca) / (2 * area2);
    if (R < min) { min = R; at = { x: b.x, y: b.y }; }
  }
  return { min, at };
}

/** Closest approach between two bits of road that aren't neighbours along the lap. */
export function minSeparation(tr, guardArc = 420, stride = 2) {
  const { pts, n, len } = tr;
  let min = Infinity, at = null;
  for (let i = 0; i < n; i += stride) {
    for (let j = i + stride; j < n; j += stride) {
      const ds = Math.abs(pts[i].s - pts[j].s);
      if (Math.min(ds, len - ds) < guardArc) continue;
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d < min) { min = d; at = { a: pts[i], b: pts[j] }; }
    }
  }
  return { min, at };
}

/** Full pass/fail, with reasons — used by the generator and the test suite. */
export function validate(tr) {
  const L = GEOMETRY_LIMITS;
  const r = minRadius(tr);
  const sep = minSeparation(tr);
  const reasons = [];
  if (r.min < tr.halfWidth * L.minRadiusFactor) {
    reasons.push(`corner radius ${r.min.toFixed(0)} < ${(tr.halfWidth * L.minRadiusFactor).toFixed(0)}`);
  }
  if (sep.min < tr.halfWidth * 2 + L.minGapExtra) {
    reasons.push(`road separation ${sep.min === Infinity ? "n/a" : sep.min.toFixed(0)} < ${tr.halfWidth * 2 + L.minGapExtra}`);
  }
  if (tr.len < L.minLength) reasons.push(`lap ${tr.len.toFixed(0)} < ${L.minLength}`);
  if (tr.len > L.maxLength) reasons.push(`lap ${tr.len.toFixed(0)} > ${L.maxLength}`);
  return { ok: reasons.length === 0, reasons, radius: r.min, separation: sep.min };
}

/* ------------------------------------------------------------------
   GENERATOR
   ------------------------------------------------------------------ */
export function generateTrack(seed, opts = {}) {
  const rnd = mulberry32(seed);
  const corners = opts.corners ?? 8 + Math.floor(rnd() * 5);      // 8..12
  const baseR = opts.baseR ?? 780 + rnd() * 420;
  const wobble = opts.wobble ?? 0.34 + rnd() * 0.24;              // radial variation
  const skew = opts.skew ?? 0.68 + rnd() * 0.34;                  // angular unevenness

  // Jittered polygon. Angles are forced to sum to exactly 2pi so the
  // shape closes without a seam kink at the start/finish line.
  const angles = [];
  let sum = 0;
  for (let i = 0; i < corners; i++) {
    const a = 1 + (rnd() - 0.5) * 2 * skew;
    angles.push(a);
    sum += a;
  }
  let acc = 0;
  const points = [];
  for (let i = 0; i < corners; i++) {
    acc += (angles[i] / sum) * Math.PI * 2;
    const r = baseR * (1 - wobble / 2 + rnd() * wobble);
    points.push([Math.cos(acc) * r, Math.sin(acc) * r]);
  }
  return buildTrack({
    id: opts.id ?? `seed-${seed}`,
    name: opts.name ?? `Circuit ${seed}`,
    seed,
    width: opts.width ?? 128,
    smooth: opts.smooth ?? 5,
    points,
  });
}

/* ------------------------------------------------------------------
   THE CURATED CIRCUITS
   Seeds were chosen by sweeping the generator and keeping the best
   mix of corner radii and lap length. Each one is re-validated by the
   test suite, so a hand-edit here can never silently ship a broken
   track.
   ------------------------------------------------------------------ */
export const TRACKS = [
  // picked by tools/track-sweep.mjs — fast and flowing, one long straight
  { id: "dockyard",   name: "Dockyard Loop", seed: 523,  width: 132, corners: 7,  baseR: 1071, wobble: 0.30, skew: 0.36, corner: 343 },
  // balanced: ten corners, a genuine hairpin, still somewhere to breathe
  { id: "switchyard", name: "Switchyard",    seed: 169,  width: 128, corners: 10, baseR: 952,  wobble: 0.52, skew: 0.45, corner: 299 },
  // twisty: the radial jitter is past the star-convex threshold, so this
  // one actually doubles back on itself and produces real S-bends
  { id: "foundry",    name: "Foundry",       seed: 635,  width: 120, corners: 13, baseR: 1122, wobble: 1.02, skew: 0.64, corner: 246 },
];

/** Resolve the curated list into runtime tracks (cached). */
let curatedCache = null;
export function curatedTracks() {
  if (curatedCache) return curatedCache;
  curatedCache = TRACKS.map(def => {
    // Built from the exact seed, NOT searched — a curated track that has
    // drifted into being invalid must fail loudly in the test suite rather
    // than silently become a different circuit.
    const tr = generateTrack(def.seed, { ...def, id: def.id, name: def.name });
    return { ...tr, width: def.width };
  });
  return curatedCache;
}

export const trackById = id => curatedTracks().find(t => t.id === id) ?? curatedTracks()[0];

/* ------------------------------------------------------------------
   QUERIES
   ------------------------------------------------------------------ */
const WINDOW = 22;

/** Closest point on segment ab to p. */
function projectSeg(ax, ay, bx, by, px, py) {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy || 1;
  let t = ((px - ax) * vx + (py - ay) * vy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + vx * t, cy = ay + vy * t;
  return { t, cx, cy, d2: (px - cx) ** 2 + (py - cy) ** 2 };
}

/**
 * Nearest point on the centreline, with the result projected onto the
 * segment rather than snapped to the nearest sample.
 *
 * Snapping is cheap but it makes arc length quantise in `step`-sized
 * jumps, which in turn makes lap distance jitter when the car is nearly
 * stationary on a sample boundary. Projecting costs two extra segment
 * tests and gives a smooth `s` and `lat`.
 */
export function nearest(tr, x, y, hint = -1) {
  const { pts, n } = tr;
  let best = 0, bd = Infinity;
  const scan = (i) => {
    const dx = pts[i].x - x, dy = pts[i].y - y;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  };
  if (hint >= 0) {
    for (let k = -WINDOW; k <= WINDOW; k++) scan(((hint + k) % n + n) % n);
  } else {
    for (let i = 0; i < n; i++) scan(i);
  }

  const a = pts[(best - 1 + n) % n], b = pts[best], c = pts[(best + 1) % n];
  const p1 = projectSeg(a.x, a.y, b.x, b.y, x, y);
  const p2 = projectSeg(b.x, b.y, c.x, c.y, x, y);

  let s, tx, ty, qx, qy;
  if (p1.d2 < p2.d2) {
    const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    s = a.s + p1.t * segLen;
    tx = (b.x - a.x) / segLen; ty = (b.y - a.y) / segLen;
    qx = p1.cx; qy = p1.cy;
  } else {
    const segLen = Math.hypot(c.x - b.x, c.y - b.y) || 1;
    s = b.s + p2.t * segLen;
    tx = (c.x - b.x) / segLen; ty = (c.y - b.y) / segLen;
    qx = p2.cx; qy = p2.cy;
  }
  const lat = tx * (y - qy) - ty * (x - qx);   // signed: + is left of travel
  return { i: best, dist: Math.hypot(x - qx, y - qy), lat, s, p: b, tx, ty, qx, qy };
}

