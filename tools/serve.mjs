/* ==================================================================
   DEV SERVER — no dependencies, no host allowlist.
   Binds 0.0.0.0 so the sandbox preview proxy can reach it, and serves
   the repo root so `index.html` and `src/` keep their relative paths
   exactly as they will on the portal.
   ================================================================== */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "0.0.0.0";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let file = path.join(ROOT, url === "/" ? "index.html" : url);

  // never serve outside the repo
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("nope"); return; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("404 " + url);
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, HOST, () => {
  console.log(`slipstream dev server → http://${HOST}:${PORT}`);
});
