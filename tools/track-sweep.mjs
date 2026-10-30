/* ==================================================================
   SEED SWEEP  (dev tool, not shipped)
   ------------------------------------------------------------------
   Scans the track generator for circuits that pass the geometry test,
   scores them on the things that make a circuit fun rather than merely
   legal (lap length, spread of corner radii, at least one fast section
   and one slow one), writes PNG previews of the winners, and prints a
   snippet you can paste straight into TRACKS.

   Run: node tools/track-sweep.mjs
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { generateTrack, validate, minRadius } from "../src/tracks.js";

/* ---------- PNG ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = buf => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function writePng(file, w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

function segDist2(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy || 1;
  let t = (wx * vx + wy * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return dx * dx + dy * dy;
}

function render(tr, scale = 0.5) {
  const pad = 260, b = tr.bounds;
  const W = Math.ceil((b.maxX - b.minX + pad * 2) * scale);
  const H = Math.ceil((b.maxY - b.minY + pad * 2) * scale);
  const ox = (-b.minX + pad) * scale, oy = (-b.minY + pad) * scale;
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = 13; buf[i * 4 + 1] = 15; buf[i * 4 + 2] = 19; buf[i * 4 + 3] = 255;
  }
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
  };
  const P = tr.pts.map(p => ({ x: p.x * scale + ox, y: p.y * scale + oy }));
  const hw = tr.halfWidth * scale;
  const passes = [
    { r2: (hw + 11 * scale) ** 2, c: [198, 74, 63] },
    { r2: hw * hw, c: [38, 41, 48] },
    { r2: (2.0 * scale) ** 2, c: [92, 98, 110] },
  ];
  for (const pass of passes) {
    const reach = Math.sqrt(pass.r2) + 2;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], c = P[(i + 1) % P.length];
      const x0 = Math.max(0, Math.floor(Math.min(a.x, c.x) - reach));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, c.x) + reach));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, c.y) - reach));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, c.y) + reach));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          if (segDist2(x, y, a.x, a.y, c.x, c.y) <= pass.r2) put(x, y, pass.c);
    }
  }
  // start / finish stripe
  const p0 = P[0], p1 = P[3];
  const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
  for (let t = -hw; t <= hw; t += 2) {
    const x = p0.x + Math.cos(ang + Math.PI / 2) * t;
    const y = p0.y + Math.sin(ang + Math.PI / 2) * t;
    put(Math.round(x), Math.round(y), (Math.round(t / 14) & 1) ? [250, 250, 250] : [20, 20, 24]);
  }
  return { buf, W, H };
}

/* ---------- sweep ---------- */
// smooth=4 is deliberate: each Chaikin iteration roughly doubles corner
// radius, and 4 is the smallest count that clears the geometry gate while
// still producing ~190-unit corners (1.5x the road half-width). Fewer
// iterations = sharper than the car can take; more = a circle.
const PROFILES = [
  { label: "fast",      corners: [7, 9],   baseR: [1050, 1350], wobble: [0.30, 0.45], skew: [0.35, 0.55], width: 132, corner: [340, 400] },
  { label: "balanced",  corners: [9, 11],  baseR: [950, 1200],  wobble: [0.42, 0.58], skew: [0.45, 0.65], width: 128, corner: [290, 340] },
  { label: "technical", corners: [11, 14], baseR: [880, 1080],  wobble: [0.48, 0.64], skew: [0.55, 0.75], width: 122, corner: [240, 285] },
  { label: "twisty",    corners: [12, 16], baseR: [1000, 1300], wobble: [0.95, 1.25], skew: [0.55, 0.78], width: 120, corner: [230, 275] },
];
const rand = (r, [lo, hi]) => lo + r * (hi - lo);

/** Radius at every sample — the raw material for "how varied is the lap?" */
function radii(tr) {
  const { pts, n } = tr;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 2 + n) % n], b = pts[i], c = pts[(i + 2) % n];
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    out.push(area2 < 1e-6 ? 1e9 : (ab * bc * ca) / (2 * area2));
  }
  return out;
}

const winners = [];
for (const prof of PROFILES) {
  for (let seed = 1; seed <= 900; seed++) {
    const r = ((seed * 2654435761) % 1000) / 1000;
    const r2 = ((seed * 40503) % 1000) / 1000;
    const opts = {
      id: `s${seed}`, name: `Circuit ${seed}`,
      corners: Math.round(rand(r, prof.corners)),
      baseR: rand(r2, prof.baseR),
      wobble: rand(r, prof.wobble),
      skew: rand(r2, prof.skew),
      width: prof.width,
      corner: rand(r2 * 0.7 + r * 0.3, prof.corner),
    };
    const tr = generateTrack(seed, opts);
    const v = validate(tr);
    if (!v.ok) continue;

    const rs = radii(tr);
    const tightFrac = rs.filter(x => x < 350).length / rs.length;   // corners you must slow for
    const fastFrac = rs.filter(x => x > 900).length / rs.length;    // somewhere to breathe
    // a good lap has both; punish uniformity hard
    let score = 0;
    score += 40 * Math.max(0, 1 - Math.abs(tightFrac - 0.22) / 0.22);
    score += 30 * Math.max(0, 1 - Math.abs(fastFrac - 0.42) / 0.42);
    score += 30 * Math.max(0, 1 - Math.abs(tr.len - 4600) / 2200);
    winners.push({ seed, prof: prof.label, opts, len: tr.len, radius: v.radius, sep: v.separation, tightFrac, fastFrac, score });
  }
}

winners.sort((a, b) => b.score - a.score);
const outDir = path.resolve(".arena/preview");
fs.mkdirSync(outDir, { recursive: true });

const picked = [];
for (const prof of PROFILES) {
  picked.push(...winners.filter(w => w.prof === prof.label).slice(0, 2));
}

console.log(`\nvalid tracks found: ${winners.length}`);
for (const w of picked) {
  const tr = generateTrack(w.seed, w.opts);
  const { buf, W, H } = render(tr);
  const file = path.join(outDir, `${w.prof}-${w.seed}.png`);
  writePng(file, W, H, buf);
  console.log(
    `  ${w.prof.padEnd(10)} seed ${String(w.seed).padEnd(5)} lap ${w.len.toFixed(0).padStart(5)} ` +
    `minR ${w.radius.toFixed(0).padStart(4)} lap  tight ${(w.tightFrac * 100).toFixed(0).padStart(2)}% ` +
    `fast ${(w.fastFrac * 100).toFixed(0).padStart(2)}%  -> ${path.relative(process.cwd(), file)}`
  );
  console.log(`      ${JSON.stringify({ seed: w.seed, corners: w.opts.corners, baseR: +w.opts.baseR.toFixed(0), wobble: +w.opts.wobble.toFixed(2), skew: +w.opts.skew.toFixed(2), width: w.opts.width, corner: Math.round(w.opts.corner) })}`);
}
