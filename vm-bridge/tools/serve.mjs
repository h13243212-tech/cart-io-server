/* ==================================================================
   DEV SERVER + AGENT PROXY
   ------------------------------------------------------------------
   Serves the harness page and static files, and reverse-proxies /agent/*
   to the bridge agent on 127.0.0.1:8787.

   The proxy exists so the harness can be opened in a browser that cannot
   reach the agent directly — a sandbox preview, a remote dev box, or any
   https origin (where a direct http://127.0.0.1 fetch would be blocked as
   mixed content). It is a development convenience only. The extension
   deliberately does NOT use it: it talks to the loopback agent directly,
   because that is the whole reason it has host permissions.

     node tools/serve.mjs              # http://localhost:5175
     BRIDGE_DEMO=1 node tools/serve.mjs   # also expose /agent-token (demo only)
   ================================================================== */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 5175);
const HOST = process.env.HOST || "0.0.0.0";
const AGENT = process.env.AGENT_URL || "http://127.0.0.1:8787";
const DEMO = process.env.BRIDGE_DEMO === "1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

function proxy(req, res) {
  const target = new URL(req.url.replace(/^\/agent/, "") || "/", AGENT);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;          // the agent's CORS check is for browsers, not us

  const up = http.request(
    { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers },
    upRes => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    }
  );
  up.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "agent unreachable at " + AGENT }));
    } else {
      res.end();
    }
  });
  req.pipe(up);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);

  if (url.startsWith("/agent/")) return proxy(req, res);

  // Demo convenience: hand the harness the token so the preview works with
  // zero setup. Never enable this on anything reachable by other people.
  if (url === "/agent-token") {
    if (!DEMO) { res.writeHead(404).end("demo mode off"); return; }
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end(process.env.BRIDGE_TOKEN || "");
    return;
  }

  const file = path.join(ROOT, url === "/" ? "tools/harness.html" : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("404 " + url); return; }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`bridge harness → http://${HOST}:${PORT}  (proxy → ${AGENT}${DEMO ? ", demo token on" : ""})`);
});
