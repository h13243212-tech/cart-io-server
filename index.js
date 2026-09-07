/* ==================================================================
   CART.IO — GAME SERVER
   ------------------------------------------------------------------
   Plain WebSocket + the shared simulation in ../shared/sim.js.

   WHY NOT COLYSEUS?
   The first version of this used Colyseus. It worked, and its test suite
   passed. I removed it anyway, for three reasons:

     1. The client library is 372 KB. CrazyGames gates on a 50 MB initial
        load and load speed feeds the conversion metric they judge you on.
        The entire rest of this game is under 40 KB.
     2. Colyseus's big win is delta-compressed SCHEMA state. We don't use
        schema — we broadcast compact JSON snapshots (~2 KB). So we'd pay
        the weight for a feature we don't use.
     3. One dependency, `ws`.

   The trade is that we hand-roll room management. That's ~60 lines, below.

   THE SECURITY MODEL
   The server owns the truth. Clients send INTENT (which way am I pushing,
   am I holding grab). They never send a position or a score. Every rule —
   banking, busting, movement — runs in shared/sim.js on this machine.
   A modified client can move its own inputs; it cannot invent a result.

   Deployment: Koyeb free tier (0.1 vCPU, 512 MB, always-on, no sleep).
   Koyeb terminates TLS and forwards to $PORT, so `wss://` works in
   production while `ws://` is fine locally.
   ================================================================== */
// `ws` is CommonJS. Node's ESM named-export detection only picks up the
// readyState constants off it, so `import { WebSocketServer } from "ws"`
// silently gives you undefined. createRequire is the reliable interop.
import { createRequire } from "module";
import http from "node:http";
const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require("ws");
import {
  createWorld, joinWorld, leaveWorld, tickWorld, snapshot,
  rollItems, makeGuard, respawn,
  TUNING, BOT_NAMES, ITEM_TYPES, WORLD,
} from "./shared/sim.js";

const PORT = Number(process.env.PORT || 2567);
const HOST = process.env.HOST || "0.0.0.0";   // must be 0.0.0.0, never 127.0.0.1
const TARGET_LOBBY = 8;                        // humans displace bots one-for-one
const MAX_CLIENTS = TUNING.lobby.maxPlayers;

// ------------------------------------------------------------------
// ROOMS
// ------------------------------------------------------------------
const rooms = new Set();

class Room {
  constructor(id) {
    this.id = id;
    this.world = createWorld({ bots: TARGET_LOBBY });
    this.clients = new Map();   // ws -> thief
    this.roundNo = 1;
    this.restarting = false;
    this.open = true;

    const dt = 1 / TUNING.lobby.tickRate;
    this.timer = setInterval(() => this.tick(dt), 1000 / TUNING.lobby.tickRate);
    rooms.add(this);
    log(`room ${id} created · ${this.world.thieves.length} bots`);
  }

  get humans() { return this.clients.size; }
  get full() { return this.humans >= MAX_CLIENTS; }

  tick(dt) {
    tickWorld(this.world, dt);
    const snap = snapshot(this.world);
    const ev = this.world.events;
    for (const [ws, thief] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      send(ws, "s", { ...snap, me: thief.id, ev });
    }
    if (this.world.over && !this.restarting) {
      this.restarting = true;
      // Same group continues — CrazyGames requires rooms persist across
      // rounds so players aren't routed back through the portal UI.
      setTimeout(() => this.nextRound(), 4000);
    }
  }

  nextRound() {
    const w = this.world;
    w.items = rollItems();
    w.guard = makeGuard();
    w.timeLeft = TUNING.round.seconds;
    w.vanGone = false; w.vanLeaving = false; w.over = false;
    w.events.length = 0;
    for (const t of w.thieves) {
      respawn(t);
      t.dead = 0; t.liftT = 0; t.wobble = 0;
      t.dodgeT = 0; t.dodgeCd = 0;
      t.path = []; t.repath = 0; t.panic = 0; t.targetId = null;
      t.aliveTime = 0;
      // cash and banked persist: that's the running match score
    }
    this.roundNo++;
    this.restarting = false;
    this.broadcast("round", { n: this.roundNo });
    log(`room ${this.id} round ${this.roundNo} · ${this.humans} human(s)`);
  }

  join(ws, name) {
    // A human takes a bot's slot so the lobby stays lively at any population.
    if (this.world.thieves.length >= TARGET_LOBBY) {
      const i = this.world.thieves.findIndex(t => t.isBot);
      if (i >= 0) {
        const bot = this.world.thieves[i];
        const it = bot.carryingId != null ? this.world.items[bot.carryingId] : null;
        if (it) { it.carried = false; it.by = null; }
        this.world.thieves.splice(i, 1);
      }
    }
    const thief = joinWorld(this.world, name);
    this.clients.set(ws, thief);
    send(ws, "welcome", {
      id: thief.id, name: thief.name, room: this.id,
      tick: TUNING.lobby.tickRate, tuning: TUNING, items: ITEM_TYPES,
      world: WORLD, tile: 60,
    });
    this.broadcastRoster();
    log(`room ${this.id} "${thief.name}" joined · ${this.humans} human(s), ${this.world.thieves.length - this.humans} bot(s)`);
  }

  leave(ws) {
    const thief = this.clients.get(ws);
    if (!thief) return;
    leaveWorld(this.world, thief.id);
    this.clients.delete(ws);
    // top the lobby back up so it never feels empty
    while (this.world.thieves.length < TARGET_LOBBY) {
      const b = joinWorld(this.world, BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]);
      b.isBot = true;
    }
    this.broadcastRoster();
    log(`room ${this.id} "${thief.name}" left · ${this.humans} human(s)`);
    if (this.humans === 0) this.dispose();
  }

  broadcastRoster() {
    this.broadcast("roster", {
      humans: this.humans,
      bots: this.world.thieves.length - this.humans,
      room: this.id,
    });
  }

  broadcast(type, msg) {
    for (const ws of this.clients.keys()) send(ws, type, msg);
  }

  dispose() {
    clearInterval(this.timer);
    this.open = false;
    rooms.delete(this);
    log(`room ${this.id} disposed`);
  }
}

/** Find a joinable room or make one. This is the whole of our matchmaking. */
function findRoom() {
  for (const r of rooms) if (r.open && !r.full) return r;
  return new Room(Math.random().toString(36).slice(2, 8));
}

// ------------------------------------------------------------------
// PROTOCOL
//   Everything is one small JSON envelope: { t: type, d: data }
//   Server -> client: welcome, s (snapshot), roster, round
//   Client -> server: join, i (intent), name
// ------------------------------------------------------------------
function send(ws, t, d) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ t, d })); } catch { /* socket died mid-write */ }
}

// Koyeb (and every other PaaS) health-checks the service with a plain HTTP
// GET. A bare WebSocketServer answers those with 426 Upgrade Required, so the
// platform marks a perfectly healthy game server as DOWN and restarts it in a
// loop. So we own the HTTP layer ourselves: serve /health, and hand everything
// else to the WebSocket upgrade.
const httpServer = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/health" || url === "/") {
    const players = [...rooms].reduce((n, r) => n + r.humans, 0);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      game: "cart.io",
      rooms: rooms.size,
      players,
      uptime_s: Math.round(process.uptime()),
    }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("cart.io game server — this is a WebSocket endpoint, not a web page\n");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", ws => {
  let room = null;
  let thief = null;

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }   // garbage in, silence out
    if (!msg || typeof msg !== "object") return;

    switch (msg.t) {
      case "join": {
        if (room) return;                                // already joined
        room = findRoom();
        room.join(ws, sanitize(msg.name));
        thief = room.clients.get(ws);
        break;
      }
      case "i": {
        if (!thief) return;
        const d = msg.d || {};
        // Whitelist and clamp. Never trust a client's numbers.
        thief.input.x = clamp(d.x, -1, 1);
        thief.input.y = clamp(d.y, -1, 1);
        thief.input.grab = !!d.g;
        thief.input.dodge = !!d.d;
        if (d.q) thief.input.drop = true;
        break;
      }
      case "name": {
        if (thief) thief.name = sanitize(msg.name);
        break;
      }
      case "ping": {
        // Cheap latency probe for the client's HUD. Deliberately answered
        // outside the tick loop so it reflects the socket, not the sim.
        send(ws, "pong", {});
        break;
      }
      default:
        // Unknown types are IGNORED, not punished. Dropping the client here
        // (which is what Colyseus does, code 4002) turns a client/server
        // version mismatch into a mystery disconnect. Silence is kinder and
        // no less safe — an unhandled type simply cannot do anything.
        break;
    }
  });

  ws.on("close", () => { if (room) room.leave(ws); });
  ws.on("error", () => { if (room) room.leave(ws); });
});

// ------------------------------------------------------------------
function clamp(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
}
function sanitize(s) {
  const clean = typeof s === "string" ? s.replace(/[^\w\-. ]/g, "").trim() : "";
  return clean.slice(0, 16) || `player${Math.floor(Math.random() * 999)}`;
}
function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

httpServer.listen(PORT, HOST);

httpServer.on("listening", () => {
  console.log("");
  console.log(`  Cart.io server on ${HOST}:${PORT}`);
  console.log(`  tick ${TUNING.lobby.tickRate}Hz · lobby target ${TARGET_LOBBY} · max ${MAX_CLIENTS}/room`);
  console.log(`  world ${WORLD.w}x${WORLD.h}`);
  console.log(`  health check: http://${HOST}:${PORT}/health`);
  console.log("");
});

process.on("SIGTERM", () => { wss.close(); httpServer.close(); process.exit(0); });
