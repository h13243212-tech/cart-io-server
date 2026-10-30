/* ==================================================================
   INPUT — keyboard + touch, collapsed into one analogue intent.
   ------------------------------------------------------------------
   Keys are read from `event.code`, not `event.key`. Code is the physical
   key position, so WASD works on an AZERTY keyboard (where the same
   physical keys are printed ZQSD) without asking the player to rebind —
   which is exactly what the CrazyGames quality guidelines ask for.
   Crab-avoidance: Escape and Ctrl/Cmd+W are never bound, because the
   browser and the portal iframe own those.
   ================================================================== */

const LEFT = ["ArrowLeft", "KeyA"];
const RIGHT = ["ArrowRight", "KeyD"];
const GAS = ["ArrowUp", "KeyW"];
const BRAKE = ["ArrowDown", "KeyS"];
const DRIFT = ["Space"];

export class Input {
  constructor(el = window) {
    this.down = new Set();
    this.touch = { left: false, right: false, brake: false, drift: false };
    // Touch devices get automatic throttle: one thumb steers, one brakes.
    // Two-thumb throttle+steer on a phone is a losing interface.
    this.autoThrottle = matchMedia("(pointer: coarse)").matches;
    this.any = false;

    el.addEventListener("keydown", e => {
      // let the portal's own shortcuts through, but stop the page scrolling
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      this.any = true;
      if (this.onKey) this.onKey(e.code);
    }, { passive: false });

    el.addEventListener("keyup", e => this.down.delete(e.code));
    window.addEventListener("blur", () => this.down.clear());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.down.clear(); });

    const hit = (codes) => codes.some(c => this.down.has(c));
    this._hit = hit;
  }

  /** Bind the on-screen buttons. Returns the root element for showing/hiding. */
  bindTouch(root) {
    const btns = [...root.querySelectorAll("[data-k]")];
    for (const b of btns) {
      const k = b.dataset.k;
      const set = (v) => {
        this.touch[k] = v;
        b.classList.toggle("press", v);
        if (v) this.any = true;
      };
      b.addEventListener("pointerdown", e => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); set(true); });
      b.addEventListener("pointerup", e => { e.preventDefault(); set(false); });
      b.addEventListener("pointercancel", () => set(false));
      b.addEventListener("pointerleave", () => set(false));
    }
    return root;
  }

  get steering() {
    const l = this._hit(LEFT) || this.touch.left;
    const r = this._hit(RIGHT) || this.touch.right;
    return (r ? 1 : 0) - (l ? 1 : 0);
  }

  get throttle() {
    const gas = this._hit(GAS);
    if (this._hit(BRAKE) || this.touch.brake) return -1;
    if (gas) return 1;
    return this.autoThrottle ? 1 : 0;   // touch: always rolling
  }

  get handbrake() {
    return this._hit(DRIFT) || this.touch.drift;
  }
}
