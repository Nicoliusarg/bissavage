// scripts/update-bis.js
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";

const ROOT = process.cwd();
const SRC  = path.join(ROOT, "data", "bis-source.yaml");
const OUT  = path.join(ROOT, "bis-feed.json");

function nowISO(){ return new Date().toISOString(); }

const raw = await fs.readFile(SRC, "utf8");        // ← lee el YAML
const y = yaml.parse(raw);
if (!y?.data) throw new Error("data/bis-source.yaml: falta 'data'");

const out = {
  meta: { season: y.meta?.season || "", updated: nowISO() },
  labels: y.labels || {},
  data: y.data
};

await fs.writeFile(OUT, JSON.stringify(out, null, 2), "utf8");
console.log("✔ Generado bis-feed.json");
