// scripts/build-icons.mjs
import fs from "node:fs/promises";

const REGION = process.env.BLIZZARD_REGION || "us";
const LOCALE = process.env.BLIZZARD_LOCALE || "es_MX";
const API = `https://${REGION}.api.blizzard.com`;
const NS  = `static-${REGION}`;

async function getToken(){
  const r = await fetch("https://oauth.battle.net/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.BLIZZARD_CLIENT_ID,
      client_secret: process.env.BLIZZARD_CLIENT_SECRET
    })
  });
  const j = await r.json();
  if(!j.access_token) throw new Error("No se pudo obtener token de Blizzard");
  return j.access_token;
}

async function getJSON(url, token){
  const r = await fetch(url + `&access_token=${token}`);
  if(!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function classIcons(token){
  const idx = await getJSON(`${API}/data/wow/playable-class/index?namespace=${NS}&locale=${LOCALE}`, token);
  const out = {};
  for(const c of idx.classes){
    const details = await getJSON(`${API}/data/wow/playable-class/${c.id}?namespace=${NS}&locale=${LOCALE}`, token);
    const media   = await getJSON(`${API}/data/wow/media/playable-class/${c.id}?namespace=${NS}&locale=${LOCALE}`, token);
    const asset = (media.assets||[])[0]?.value || "";
    out[c.id] = { id:c.id, name: details.name, icon: asset };
  }
  return out;
}

async function raceIcons(token){
  const idx = await getJSON(`${API}/data/wow/playable-race/index?namespace=${NS}&locale=${LOCALE}`, token);
  const out = {};
  for(const r of idx.races){
    const details = await getJSON(`${API}/data/wow/playable-race/${r.id}?namespace=${NS}&locale=${LOCALE}`, token);
    const media   = await getJSON(`${API}/data/wow/media/playable-race/${r.id}?namespace=${NS}&locale=${LOCALE}`, token);
    const asset = (media.assets||[])[0]?.value || "";
    out[r.id] = { id:r.id, name: details.name, icon: asset };
  }
  return out;
}

const token = await getToken();
const classes = await classIcons(token);
const races   = await raceIcons(token);

// Escribimos como JS global para que el front lo cargue fácil:
const js = `window.WOW_ICONS=${JSON.stringify({classes, races})};`;
await fs.writeFile("wow-icons.js", js, "utf8");
console.log("✔ Generado wow-icons.js con clases y razas");
