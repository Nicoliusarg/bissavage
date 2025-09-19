// scripts/build-icons.mjs
import fs from "node:fs/promises";

// --- Config / Secrets ---
const {
  BLIZZARD_CLIENT_ID: CID,
  BLIZZARD_CLIENT_SECRET: SEC,
  BLIZZARD_REGION: REG = "us",
  BLIZZARD_LOCALE: LOC = "es_MX",
} = process.env;

// Si no hay secrets: salteamos sin error
if (!CID || !SEC) {
  console.log("No Blizzard secrets; skipping icons.");
  process.exit(0);
}

const API_ORIGIN   = `https://${REG}.api.blizzard.com`;
const OAUTH_ORIGIN = `https://${REG}.battle.net`;
const NAMESPACE    = `static-${REG}`;

// --- Helpers ---
async function getToken() {
  const res = await fetch(`${OAUTH_ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CID,
      client_secret: SEC,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${text}`);
  const j = JSON.parse(text);
  if (!j.access_token) throw new Error(`OAuth sin access_token: ${text}`);
  return j.access_token;
}

async function getJSON(path, params, token) {
  const url = new URL(`${API_ORIGIN}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);

  const res = await fetch(url.toString());
  const txt = await res.text();
  if (!res.ok) {
    // Muestra la URL completa y el body del error (primeros 300 chars)
    throw new Error(`${res.status} ${url.toString()} :: ${txt.slice(0, 300)}`);
  }
  return JSON.parse(txt);
}

async function fetchClasses(locale, token) {
  const idx = await getJSON(`/data/wow/playable-class/index`,
    { namespace: NAMESPACE, locale },
    token
  );
  const out = {};
  for (const c of idx.classes) {
    const details = await getJSON(`/data/wow/playable-class/${c.id}`,
      { namespace: NAMESPACE, locale }, token);
    const media   = await getJSON(`/data/wow/media/playable-class/${c.id}`,
      { namespace: NAMESPACE, locale }, token);
    const icon = (media.assets || []).find(a => a.key === "icon")?.value
              || (media.assets || [])[0]?.value || "";
    out[c.id] = { id: c.id, name: details.name, icon };
  }
  return out;
}

async function fetchRaces(locale, token) {
  const idx = await getJSON(`/data/wow/playable-race/index`,
    { namespace: NAMESPACE, locale },
    token
  );
  const out = {};
  for (const r of idx.races) {
    const details = await getJSON(`/data/wow/playable-race/${r.id}`,
      { namespace: NAMESPACE, locale }, token);
    const media   = await getJSON(`/data/wow/media/playable-race/${r.id}`,
      { namespace: NAMESPACE, locale }, token);
    const icon = (media.assets || []).find(a => a.key === "icon")?.value
              || (media.assets || [])[0]?.value || "";
    out[r.id] = { id: r.id, name: details.name, icon };
  }
  return out;
}

// --- Main ---
try {
  const token = await getToken();

  // Intento con el locale pedido; si falla (404), caigo a en_US
  async function withLocale(fn) {
    try { return await fn(LOC, token); }
    catch (e) {
      if (String(e.message).startsWith("404 ")) {
        console.warn(`Locale ${LOC} devolvió 404; probando en_US...`);
        return await fn("en_US", token);
      }
      throw e;
    }
  }

  const classes = await withLocale(fetchClasses);
  const races   = await withLocale(fetchRaces);

  const js = `window.WOW_ICONS=${JSON.stringify({ classes, races })};`;
  await fs.writeFile("wow-icons.js", js, "utf8");
  console.log("✔ Generado wow-icons.js con clases y razas");
} catch (err) {
  console.error("✖ Error generando wow-icons.js:", err.message);
  process.exit(1);
}
