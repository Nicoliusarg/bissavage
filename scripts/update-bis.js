// scripts/update-bis.js
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";

const ROOT = process.cwd();
const SRC  = path.join(ROOT, "data", "bis-source.yaml");
const OUT_JSON = path.join(ROOT, "bis-feed.json");
const OUT_JS   = path.join(ROOT, "bis-feed.js");

function nowISO(){ return new Date().toISOString(); }

const raw = await fs.readFile(SRC, "utf8");
const y = yaml.parse(raw);
if (!y?.data) throw new Error("data/bis-source.yaml: falta 'data'");

const out = {
  meta: { season: y.meta?.season || "", updated: nowISO() },
  labels: y.labels || {},
  data: y.data
};

// 1) JSON (por si querés seguir usándolo)
await fs.writeFile(OUT_JSON, JSON.stringify(out, null, 2), "utf8");

// 2) JS global (robusto; evita fetch/CORS/paths)
const js = `window.BIS_FEED = ${JSON.stringify(out)};`;
await fs.writeFile(OUT_JS, js, "utf8");

console.log("✔ Generados bis-feed.json y bis-feed.js");
