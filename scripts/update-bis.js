// scripts/update-bis.js — Scraper Murlok + Reader (sin WCL)
// - Saca BiS por clase/spec desde Murlok (sección "Best-in-Slot Gear")
// - Usa r.jina.ai para convertir HTML→texto (evita JS/Cloudflare)
// - Clasifica origen con Blizzard Journal: raid / mplus / crafted
// Requiere: BLIZZARD_CLIENT_ID y BLIZZARD_CLIENT_SECRET

import fs from "fs";
import fetch from "node-fetch";

const {
  BLIZZARD_CLIENT_ID,
  BLIZZARD_CLIENT_SECRET,
  REGION = "us",
  LOCALE = "es_MX",
  SEASON_LABEL = "TWW S3",
} = process.env;

if (!BLIZZARD_CLIENT_ID || !BLIZZARD_CLIENT_SECRET) {
  console.error("Faltan secretos BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET");
  process.exit(1);
}

// ---------- Catálogo de clases/specs (PvE Mythic+ de Murlok)
const CLASSES = [
  { className:"Warrior", label:"Guerrero", specs:[ {specName:"Arms",label:"Armas",role:"dps"}, {specName:"Fury",label:"Furia",role:"dps"}, {specName:"Protection",label:"Protección",role:"tank"} ] },
  { className:"Paladin", label:"Paladín", specs:[ {specName:"Holy",label:"Sagrado",role:"healer"}, {specName:"Protection",label:"Protección",role:"tank"}, {specName:"Retribution",label:"Reprensión",role:"dps"} ] },
  { className:"Hunter", label:"Cazador", specs:[ {specName:"Beast Mastery",label:"Maestro de Bestias",role:"dps"}, {specName:"Marksmanship",label:"Puntería",role:"dps"}, {specName:"Survival",label:"Supervivencia",role:"dps"} ] },
  { className:"Rogue", label:"Pícaro", specs:[ {specName:"Assassination",label:"Asesinato",role:"dps"}, {specName:"Outlaw",label:"Forajido",role:"dps"}, {specName:"Subtlety",label:"Sutileza",role:"dps"} ] },
  { className:"Priest", label:"Sacerdote", specs:[ {specName:"Discipline",label:"Disciplina",role:"healer"}, {specName:"Holy",label:"Sagrado",role:"healer"}, {specName:"Shadow",label:"Sombra",role:"dps"} ] },
  { className:"Death Knight", label:"Caballero de la Muerte", specs:[ {specName:"Blood",label:"Sangre",role:"tank"}, {specName:"Frost",label:"Escarcha",role:"dps"}, {specName:"Unholy",label:"Profano",role:"dps"} ] },
  { className:"Shaman", label:"Chamán", specs:[ {specName:"Elemental",label:"Elemental",role:"dps"}, {specName:"Enhancement",label:"Mejora",role:"dps"}, {specName:"Restoration",label:"Restauración",role:"healer"} ] },
  { className:"Mage", label:"Mago", specs:[ {specName:"Arcane",label:"Arcano",role:"dps"}, {specName:"Fire",label:"Fuego",role:"dps"}, {specName:"Frost",label:"Escarcha",role:"dps"} ] },
  { className:"Warlock", label:"Brujo", specs:[ {specName:"Affliction",label:"Aflicción",role:"dps"}, {specName:"Demonology",label:"Demonología",role:"dps"}, {specName:"Destruction",label:"Destrucción",role:"dps"} ] },
  { className:"Monk", label:"Monje", specs:[ {specName:"Brewmaster",label:"Maestro Cervecero",role:"tank"}, {specName:"Mistweaver",label:"Tejedor de Niebla",role:"healer"}, {specName:"Windwalker",label:"Viajero del Viento",role:"dps"} ] },
  { className:"Druid", label:"Druida", specs:[ {specName:"Balance",label:"Equilibrio",role:"dps"}, {specName:"Feral",label:"Feral",role:"dps"}, {specName:"Guardian",label:"Guardián",role:"tank"}, {specName:"Restoration",label:"Restauración",role:"healer"} ] },
  { className:"Demon Hunter", label:"Cazador de Demonios", specs:[ {specName:"Havoc",label:"Devastación",role:"dps"}, {specName:"Vengeance",label:"Venganza",role:"tank"} ] },
  { className:"Evoker", label:"Evocador", specs:[ {specName:"Devastation",label:"Devastación",role:"dps"}, {specName:"Preservation",label:"Preservación",role:"healer"}, {specName:"Augmentation",label:"Aumentación",role:"dps"} ] },
];

// Slots “normalizados” que usa tu front
const DESIRED_SLOTS = [
  "head","neck","shoulder","back","chest","wrist","hands","waist","legs","feet",
  "ring1","ring2","trinket1","trinket2","weaponMain","weaponOff","twoHand"
];

// Mapear nombres que vienen del texto de Murlok → keys de arriba
function normalizeSlot(name) {
  const s = name.trim().toLowerCase();
  if (s.startsWith("ring")) {
    return s.includes("2") ? "ring2" : "ring1";
  }
  if (s.startsWith("trinket")) {
    return s.includes("2") ? "trinket2" : "trinket1";
  }
  if (s.includes("two") || s.includes("2-hand") || s.includes("two-hand")) return "twoHand";
  if (s.startsWith("main")) return "weaponMain";
  if (s.startsWith("off")) return "weaponOff";
  const map = {
    head:"head", neck:"neck", shoulders:"shoulder", shoulder:"shoulder",
    back:"back", cloak:"back", chest:"chest", wrist:"wrist", bracers:"wrist",
    hands:"hands", gloves:"hands", waist:"waist", belt:"waist", legs:"legs",
    feet:"feet", boots:"feet"
  };
  return map[s] || null;
}

// ---------- Reader (HTML→texto) y scraping de Murlok
const MURL = (cls, spec) => `https://murlok.io/${cls}/${spec}/${encodeURIComponent('m+')}`;
const READ = (url) => `https://r.jina.ai/${url.replace(/^https?:\/\//,"https://")}`;

// Lee como texto “limpio” (Markdown) con r.jina.ai
async function readClean(url) {
  const r = await fetch(READ(url), {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/plain" }
  });
  if (!r.ok) throw new Error(`Reader ${r.status} ${r.statusText}`);
  return r.text();
}

// Extrae el bloque “Best-in-Slot Gear …” y arma un {slot → [{id,name,tag}]}
function parseBis(markdown) {
  // 1) Cortar la sección desde "## Best-in-Slot Gear" hasta el próximo "## "
  const start = markdown.indexOf("## Best-in-Slot Gear");
  if (start < 0) return {};
  const rest = markdown.slice(start);
  const nextH2 = rest.indexOf("\n## ");
  const section = nextH2 > 0 ? rest.slice(0, nextH2) : rest;

  // 2) Partir por sub-encabezados "### <Slot>"
  // Luego líneas tipo: "0.  [Item Name](https://www.wowhead.com/item%3D12345)  Set 49"
  const out = {};
  const slotRe = /###\s+([^\n]+)\n([\s\S]*?)(?=\n###\s+|\n##\s+|$)/g;
  let m;
  while ((m = slotRe.exec(section)) !== null) {
    const slotNameRaw = m[1].trim();
    const normalized = normalizeSlot(slotNameRaw);
    if (!normalized) continue;

    const body = m[2];
    const lines = body.split("\n").map(x=>x.trim()).filter(Boolean);

    const items = [];
    for (const line of lines) {
      // Acepta "0.  [Name](URL)  <Tag?>  <count?>" (Tag puede ser "Set", "Craft", etc.)
      const match = /^\d+\.\s+\[([^\]]+)\]\(([^)]+)\)(?:\s+([A-Za-z]+))?/.exec(line);
      if (!match) continue;
      const name = match[1].trim();
      const href = decodeURIComponent(match[2]);
      const tag  = (match[3] || "").trim(); // "Set", "Craft", etc.

      // Sacar itemID del link (puede venir como item%3D12345 o item=12345)
      let id = null;
      const idMatch = /item(?:%3D|=)(\d+)/.exec(href);
      if (idMatch) id = Number(idMatch[1]);
      if (!id) continue;

      items.push({ id, name, tag });
    }

    if (items.length) out[normalized] = items;
  }

  return out;
}

// ---------- Blizzard Journal para mapear origen (raid/m+ o crafted)
async function getBnetToken(){
  const r = await fetch("https://oauth.battle.net/token", {
    method:"POST",
    headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:"client_credentials",
      client_id: BLIZZARD_CLIENT_ID,
      client_secret: BLIZZARD_CLIENT_SECRET
    })
  });
  if (!r.ok) throw new Error("BNet token "+r.status);
  return (await r.json()).access_token;
}

const instIdx = { loaded:false, list:[] }, encCache = new Map(), srcCache = new Map();

async function instances(tok){
  if (instIdx.loaded) return instIdx.list;
  const url = `https://${REGION}.api.blizzard.com/data/wow/journal-instance/index?namespace=static-${REGION}&locale=${LOCALE}&access_token=${tok}`;
  const x = await (await fetch(url)).json();
  instIdx.loaded = true;
  instIdx.list = x.instances || [];
  return instIdx.list;
}

async function encItems(href, tok){
  if (encCache.has(href)) return encCache.get(href);
  const e = await (await fetch(`${href}&access_token=${tok}`)).json();
  const ids = (e.items||[]).map(x=>x?.item?.id).filter(Boolean);
  const res = { ids, name: e.name||"" };
  encCache.set(href,res);
  return res;
}

async function sourceFor(itemId, tok){
  if (srcCache.has(itemId)) return srcCache.get(itemId);
  // Intento 1: ver si está en algún encuentro de instancias (Raid/Dungeon)
  for (const inst of await instances(tok)){
    try{
      const d = await (await fetch(`${inst.key.href}&access_token=${tok}`)).json();
      const t = d?.instance_type?.type; // "RAID" o "DUNGEON"
      for (const e of (d.encounters||[])){
        const det = await encItems(e.key.href, tok);
        if (det.ids.includes(itemId)){
          const src = t==="RAID" ? {type:"raid",instance:d.name,boss:det.name}
                    : t==="DUNGEON" ? {type:"mplus",dungeon:d.name}
                    : {type:"other"};
          srcCache.set(itemId, src);
          return src;
        }
      }
    }catch{/* ignorar y seguir */}
  }
  // Intento 2: ¿parece crafteado?
  try{
    const it = await (await fetch(
      `https://${REGION}.api.blizzard.com/data/wow/item/${itemId}?namespace=static-${REGION}&locale=${LOCALE}&access_token=${tok}`
    )).json();
    const crafted = !!(it?.preview_item && (it.preview_item.is_crafted || it.preview_item.crafted_quality || it.preview_item.crafting_reagent));
    if (crafted) {
      const src = {type:"crafted"};
      srcCache.set(itemId, src);
      return src;
    }
  }catch{/* noop */}
  const src = {type:"other"};
  srcCache.set(itemId, src);
  return src;
}

// ---------- Construye BiS de una spec (toma el #0 de cada slot)
async function buildSpec(blizzTok, classSlug, specSlug){
  const url = MURL(classSlug, specSlug);
  let text;
  try {
    text = await readClean(url);
  } catch (e) {
    console.error(`Reader fallo ${classSlug}/${specSlug}: ${e.message}`);
    return [];
  }

  const slotsMap = parseBis(text);
  const out = [];

  for (const slot of Object.keys(slotsMap)) {
    if (!DESIRED_SLOTS.includes(slot)) continue;
    // Tomamos el ítem #0 (más usado)
    const best = slotsMap[slot][0];
    if (!best) continue;
    const source = await sourceFor(best.id, blizzTok);
    out.push({
      slot,
      id: best.id,
      name: best.name,
      tag: best.tag || "",
      source
    });
  }

  // Si hay 2H, no publiques weaponMain/off; si hay main/off, mantenelos.
  const hasTwo = out.some(x=>x.slot==="twoHand");
  if (hasTwo) {
    return out.filter(x=> x.slot!=="weaponMain" && x.slot!=="weaponOff");
  }
  return out;
}

// Helpers para armar slugs de Murlok (lowercase con guiones)
function toSlug(x){
  return x.toLowerCase().replace(/\s+/g,"-");
}

// ---------- Main
async function main(){
  const blizzTok = await getBnetToken();

  const data = {};
  const labels = {};

  for (const cl of CLASSES){
    const classSlug = toSlug(cl.className);
    data[cl.className] = {};
    labels[cl.className] = { label: cl.label, specs:{} };

    for (const sp of cl.specs){
      labels[cl.className].specs[sp.specName] = sp.label;

      const specSlug = toSlug(sp.specName);
      try{
        const items = await buildSpec(blizzTok, classSlug, specSlug);
        console.log(`OK ${cl.className}/${sp.specName}: ${items.length} slots`);
        data[cl.className][sp.specName] = items;
      }catch(e){
        console.error(`Error ${cl.className}/${sp.specName}: ${e.message}`);
        data[cl.className][sp.specName] = [];
      }
    }
  }

  const out = { meta:{ season:SEASON_LABEL, updated:new Date().toISOString() }, labels, data };
  fs.writeFileSync("bis-feed.js", "window.BIS_FEED = " + JSON.stringify(out, null, 2) + ";\n");
  console.log("bis-feed.js listo.");
}

main().catch(e=>{ console.error(e); process.exit(1); });
