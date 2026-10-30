/* ==================================================================
   BUILD — assembles dist/ and checks the portal limits.
   No bundler: the game is native ES modules and one HTML file, which is
   smaller and simpler than any toolchain output. The only hard job here
   is proving the build fits CrazyGames' budget before upload:
   initial download <= 50 MB (<= 20 MB for mobile homepage), <= 1500 files.
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const files = ["index.html", "src/sim.js", "src/tracks.js", "src/render.js", "src/input.js", "src/main.js", "src/sdk.js"];
let total = 0;
for (const f of files) {
  const src = path.join(ROOT, f);
  const dst = path.join(DIST, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  total += fs.statSync(src).size;
}

const MB = total / 1048576;
const LIMITS = { initialMB: 50, mobileMB: 20, maxFiles: 1500 };
const problems = [];
if (MB > LIMITS.initialMB) problems.push(`initial download ${MB.toFixed(2)} MB > ${LIMITS.initialMB} MB`);
if (MB > LIMITS.mobileMB) problems.push(`over ${LIMITS.mobileMB} MB — not eligible for the mobile homepage (not fatal)`);
if (files.length > LIMITS.maxFiles) problems.push(`${files.length} files > ${LIMITS.maxFiles}`);

// absolute paths or external URLs in the shipped code are a hard rejection
for (const f of files) {
  const txt = fs.readFileSync(path.join(DIST, f), "utf8");
  const bad = txt.match(/(?:src|href)\s*=\s*["']\/(?!\/)/g);
  if (bad) problems.push(`${f} contains a root-absolute path (${bad.length})`);
}

console.log(`built dist/ — ${files.length} files, ${(total / 1024).toFixed(0)} KB`);
for (const p of problems) console.log(`  ${p.startsWith("over") ? "note:" : "FAIL:"} ${p}`);
const fatal = problems.filter(p => !p.startsWith("over"));
console.log(fatal.length ? "  build does not meet portal requirements" : "  meets portal requirements");
process.exit(fatal.length ? 1 : 0);
