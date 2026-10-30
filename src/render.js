/* ==================================================================
   RENDER — canvas 2D. Reads sim state, never writes it.
   ------------------------------------------------------------------
   There are no image assets. The circuit is a stroked polyline, which
   means the whole art budget is a few colours and a build under 100 KB.
   It also means the road drawn on screen is exactly the road the physics
   collides with, because both come from the same centerline samples.

   The circuit is baked once to an offscreen canvas at world scale, then
   blitted with a camera transform each frame — so per-frame cost is one
   drawImage plus two small cars, and the detailed curbs and markings are
   free. Skid marks get their own persistent layer for the same reason.
   ================================================================== */

const MARGIN = 560;
const COL = {
  ground: "#0e1116",
  speck: "rgba(255,255,255,0.028)",
  asphalt: "#2b3038",
  edge: "rgba(226,232,240,0.62)",
  centerline: "rgba(255,255,255,0.10)",
  curbA: "#c2453c",
  curbB: "#e9ecf1",
  player: "#ff5a4d",
  playerDark: "#b8352c",
  ghost: "#4cc7f0",
  glass: "#0b1219",
};

/* ------------------------------------------------------------------
   BAKE — the static circuit
   ------------------------------------------------------------------ */
export function bakeTrack(tr) {
  const b = tr.bounds;
  const w = Math.ceil(b.maxX - b.minX + MARGIN * 2);
  const h = Math.ceil(b.maxY - b.minY + MARGIN * 2);
  const ox = MARGIN - b.minX;
  const oy = MARGIN - b.minY;

  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const g = cv.getContext("2d");
  g.translate(ox, oy);

  const path = new Path2D();
  path.moveTo(tr.pts[0].x, tr.pts[0].y);
  for (let i = 1; i < tr.n; i++) path.lineTo(tr.pts[i].x, tr.pts[i].y);
  path.closePath();

  const hw = tr.halfWidth;

  // ground + grain (deterministic, so the texture doesn't crawl)
  g.fillStyle = COL.ground;
  g.fillRect(-MARGIN, -MARGIN, w, h);
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  g.fillStyle = COL.speck;
  for (let i = 0; i < 5200; i++) {
    g.fillRect((rnd() - 0.5) * w, (rnd() - 0.5) * h, 2, 2);
  }

  g.lineJoin = "round";
  g.lineCap = "butt";

  // curbs: two dashed passes offset by one dash, so red and white alternate
  const DASH = 30;
  g.lineWidth = hw * 2 + 30;
  g.setLineDash([DASH, DASH]);
  g.lineDashOffset = 0;
  g.strokeStyle = COL.curbA;
  g.stroke(path);
  g.lineDashOffset = DASH;
  g.strokeStyle = COL.curbB;
  g.stroke(path);

  // asphalt covers the inner half of the curb stroke, leaving a rim
  g.setLineDash([]);
  g.lineWidth = hw * 2;
  g.strokeStyle = COL.asphalt;
  g.stroke(path);

  // inner edge line
  g.lineWidth = hw * 2 - 3;
  g.strokeStyle = COL.edge;
  g.stroke(path);
  g.lineWidth = hw * 2 - 9;
  g.strokeStyle = COL.asphalt;
  g.stroke(path);

  // centre line
  g.setLineDash([56, 66]);
  g.lineWidth = 5;
  g.strokeStyle = COL.centerline;
  g.stroke(path);
  g.setLineDash([]);

  // start / finish: a checkered band across the road
  const p = tr.pts[tr.startIndex ?? 0];
  g.save();
  g.translate(p.x, p.y);
  g.rotate(Math.atan2(p.ty, p.tx));
  const bandW = 34, cols = 8, rows = 6;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      g.fillStyle = (c + r) % 2 ? "#eef2f7" : "#191d24";
      g.fillRect(-bandW / 2 + (c * bandW) / cols, -hw + (r * hw * 2) / rows, bandW / cols + 0.5, (hw * 2) / rows + 0.5);
    }
  }
  g.restore();

  return { canvas: cv, ox, oy, w, h };
}

/* ------------------------------------------------------------------
   CAR
   ------------------------------------------------------------------ */
function carPath(g, L, W) {
  const hl = L / 2, hwid = W / 2, r = 7;
  g.beginPath();
  g.moveTo(-hl + r, -hwid);
  g.lineTo(hl - r, -hwid);
  g.quadraticCurveTo(hl, -hwid, hl, -hwid + r);
  g.lineTo(hl, hwid - r);
  g.quadraticCurveTo(hl, hwid, hl - r, hwid);
  g.lineTo(-hl + r, hwid);
  g.quadraticCurveTo(-hl, hwid, -hl, hwid - r);
  g.lineTo(-hl, -hwid + r);
  g.quadraticCurveTo(-hl, -hwid, -hl + r, -hwid);
  g.closePath();
}

function drawCar(g, x, y, a, opts = {}) {
  const L = opts.length ?? 46, W = opts.width ?? 24;
  const ghost = opts.ghost;
  g.save();
  g.translate(x, y);

  // ground shadow stays world-aligned-ish (cheap, reads as height)
  g.save();
  g.rotate(a);
  g.fillStyle = "rgba(0,0,0,0.34)";
  g.translate(3, 4);
  carPath(g, L, W);
  g.fill();
  g.restore();

  g.rotate(a);
  const steer = opts.steer ?? 0;
  const wheel = (wx, wy, ang) => {
    g.save(); g.translate(wx, wy); g.rotate(ang);
    g.fillStyle = "#12151a";
    g.fillRect(-6, -3.2, 12, 6.4);
    g.restore();
  };
  wheel(L * 0.27, -W / 2 + 1, steer * 0.45);
  wheel(L * 0.27, W / 2 - 1, steer * 0.45);
  wheel(-L * 0.28, -W / 2 + 1, 0);
  wheel(-L * 0.28, W / 2 - 1, 0);

  const grd = g.createLinearGradient(-L / 2, 0, L / 2, 0);
  if (ghost) {
    grd.addColorStop(0, "rgba(76,199,240,0.16)");
    grd.addColorStop(1, "rgba(76,199,240,0.42)");
  } else {
    grd.addColorStop(0, opts.dark ?? COL.playerDark);
    grd.addColorStop(0.45, opts.color ?? COL.player);
    grd.addColorStop(1, "#ff8b7f");
  }
  carPath(g, L, W);
  g.fillStyle = grd;
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = ghost ? "rgba(140,225,255,0.55)" : "rgba(0,0,0,0.35)";
  g.stroke();

  // cockpit
  g.fillStyle = ghost ? "rgba(8,30,40,0.45)" : COL.glass;
  g.beginPath();
  g.ellipse(L * 0.02, 0, L * 0.19, W * 0.30, 0, 0, Math.PI * 2);
  g.fill();

  // nose stripe
  g.fillStyle = ghost ? "rgba(200,240,255,0.28)" : "rgba(255,255,255,0.72)";
  g.fillRect(L * 0.28, -W * 0.13, L * 0.16, W * 0.26);

  // brake lights
  if (opts.braking) {
    g.fillStyle = "rgba(255,70,60,0.95)";
    g.fillRect(-L / 2 - 1, -W * 0.36, 3.5, W * 0.24);
    g.fillRect(-L / 2 - 1, W * 0.12, 3.5, W * 0.24);
  }
  g.restore();
}

/* ------------------------------------------------------------------
   RENDERER
   ------------------------------------------------------------------ */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d", { alpha: false });
    this.dpr = 1;
    this.cam = { x: 0, y: 0 };
    this.zoom = 0.8;
    this.shake = 0;
    this.particles = [];
    this.subject = null;
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.viewW = w; this.viewH = h;
    // zoom so the same amount of track is visible on a phone and a desktop
    this.zoom = Math.max(0.52, Math.min(0.98, Math.min(w, h) / 760));
  }

  /** Called when a new run starts: clears skids and snaps the camera. */
  reset(tr, baked) {
    this.baked = baked;
    this.tr = tr;
    this.cam.x = tr.pts[tr.startIndex ?? 0].x;
    this.cam.y = tr.pts[tr.startIndex ?? 0].y;
    this.particles.length = 0;
    this.shake = 0;
    const skid = document.createElement("canvas");
    skid.width = baked.w; skid.height = baked.h;
    this.skid = skid;
    this.skidCtx = skid.getContext("2d");
    this.skidCtx.translate(baked.ox, baked.oy);
  }

  draw(run, input, dtReal, state) {
    const g = this.g;
    const { viewW, viewH, dpr } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = COL.ground;
    g.fillRect(0, 0, viewW, viewH);
    if (!this.baked) return;

    const car = run.car;

    // camera: follow with a velocity lookahead so you can see where you're going
    const speed = Math.hypot(car.vx, car.vy);
    const tx = car.x + car.vx * 0.30;
    const ty = car.y + car.vy * 0.30;
    const k = Math.min(1, dtReal * 7);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;

    // zoom out a touch with speed — cheap, effective sense of pace
    const zoom = this.zoom * (1 - Math.min(0.14, speed / 3400));
    const halfW = viewW / 2 / zoom, halfH = viewH / 2 / zoom;
    const bx = this.baked;

    // Keep the camera inside the baked world so the edge of the offscreen
    // canvas is never visible. If the viewport is bigger than the world,
    // centre on it instead.
    const clampX = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
    const cx = clampX(this.cam.x, -bx.ox + halfW, bx.w - bx.ox - halfW);
    const cy = clampX(this.cam.y, -bx.oy + halfH, bx.h - bx.oy - halfH);

    this.shake *= 0.9;
    const sh = this.shake * 9;
    const shx = sh ? (Math.random() - 0.5) * sh : 0;
    const shy = sh ? (Math.random() - 0.5) * sh : 0;

    g.save();
    g.translate(viewW / 2 + shx, viewH / 2 + shy);
    g.scale(zoom, zoom);
    g.translate(-cx, -cy);

    g.drawImage(bx.canvas, -bx.ox, -bx.oy);
    if (this.skid) g.drawImage(this.skid, -bx.ox, -bx.oy);

    // skid marks + smoke
    const slip = car.slip;
    const laying = slip > 0.18 && speed > 55;
    if (laying && this.skidCtx) {
      const c = Math.cos(car.a), s = Math.sin(car.a);
      for (const side of [-1, 1]) {
        const lx = -13, ly = side * (11);
        const wx = car.x + c * lx - s * ly;
        const wy = car.y + s * lx + c * ly;
        const sc = this.skidCtx;
        sc.fillStyle = `rgba(10,10,12,${Math.min(0.5, slip * 0.7)})`;
        sc.beginPath();
        sc.arc(wx, wy, 5.2, 0, Math.PI * 2);
        sc.fill();
      }
      if (Math.random() < Math.min(0.9, slip * 1.6) && this.particles.length < 260) {
        for (const side of [-1, 1]) {
          const lx = -16, ly = side * 11;
          const wx = car.x + c * lx - s * ly;
          const wy = car.y + s * lx + c * ly;
          this.particles.push({
            x: wx, y: wy,
            vx: -c * 30 + (Math.random() - 0.5) * 40,
            vy: -s * 30 + (Math.random() - 0.5) * 40,
            r: 5 + Math.random() * 7,
            life: 1,
          });
        }
      }
    }

    // ghost first so the player car always reads on top
    const ghost = run.ghost;
    if (ghost && ghost.length && state === "racing") {
      const i = Math.min(ghost.length - 1, Math.floor(run.lapT * 30));
      const f = ghost[i];
      if (f) drawCar(g, f.x, f.y, f.a, { ghost: true });
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dtReal * 1.6;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.x += p.vx * dtReal; p.y += p.vy * dtReal;
      p.vx *= 0.96; p.vy *= 0.96;
      p.r += dtReal * 26;
      g.fillStyle = `rgba(210,215,225,${p.life * 0.20})`;
      g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fill();
    }

    drawCar(g, car.x, car.y, car.a, {
      steer: input.steer ?? 0,
      braking: (input.thr ?? 0) < 0,
    });

    g.restore();
  }
}
