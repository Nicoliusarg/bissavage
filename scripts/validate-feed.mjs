// scripts/validate-feed.mjs
import fs from "node:fs";

try {
  const s = fs.readFileSync("bis-feed.json", "utf8");
  const j = JSON.parse(s);
  if (!j || !j.data || !Object.keys(j.data).length) {
    console.error("Feed vacío o sin data");
    process.exit(1);
  }
  console.log("Feed OK · clases:", Object.keys(j.data).length);
} catch (e) {
  console.error("JSON inválido:", e.message);
  process.exit(1);
}
