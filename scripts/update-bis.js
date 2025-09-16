// scripts/update-bis.js — BIS por clase/spec desde Murlok.io (M+) + origen con Blizzard
// Requisitos:
//   - Secrets: BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET
//   - Deps: node-fetch@3, cheerio@1
//
// Flujo:
//   1) Scrape de https://murlok.io/<class>/<spec>/m%2B → sección "Best-in-Slot Gear"
//   2) Extraer IDs de Wowhead (maneja item%3D12345 y formatos comunes)
//   3) Consultar Journal de Blizzard para marcar origen: raid/mplus/crafted/other
//   4) Generar bis-feed.js con labels ES que tu index.html ya usa

import fs from "fs";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const {
  BLIZZARD_CLIENT_ID,
  BLIZZARD_CLIENT_SECRET,
  REGION = "us",
  LOCALE = "es_MX",
  SEASON_LABEL = "TWW S3",
} = process.env;

if (!BLIZZARD_CLIENT_ID || !BLIZZARD_CLIENT_SECRET) {
  console.error("Faltan BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET");
  process.exit(1);
}

// --------- Clases/specs + slugs de Murlok (M+)
const CLASSES = [
  { className:"Warrior", slug:"warrior", label:"Guerrero",
    specs:[["Arms","arms","Armas"],["Fury","fury","Furia"],["Protection","protection","Protección"]] },
  { className:"Paladin", slug:"paladin", label:"Paladín",
    specs:[["Holy","holy","Sagrado"],["Protection","protection","Protección"],["Retribution","retribution","Reprensión"]] },
  { className:"Hunter", slug:"hunter", label:"Cazador",
    specs:[["Beast Mastery","beast-mastery","Maestro de Bestias"],["Marksmanship","marksmanship","Puntería"],["Survival","survival","Supervivencia"]] },
  { className:"Rogue", slug:"rogue", label:"Pícaro",
    specs:[["Assassination","assassination","Asesinato"],["Outlaw","outlaw","Forajido"],["Subtlety","subtlety","Sutileza"]] },
  { className:"Priest", slug:"priest", label:"Sacerdote",
    specs:[["Discipline","discipline","Disciplina"],["Holy","holy","Sagrado"],["Shadow","shadow","Sombra"]] },
  { className:"Death Knight", slug:"death-knight", label:"Caballero de la Muerte",
    specs:[["Blood","blood","Sangre"],["Frost","frost","Escarcha"],["Unholy","unholy","Profano"]] },
  { className:"Shaman", slug:"shaman", label:"Chamán",
    specs:[["Elemental","elemental","Elemental"],["Enhancement","enhancement","Mejora"],["Restoration","restoration","Restauración"]] },
  { className:"Mage", slug:"mage", label:"Mago",
    specs:[["Arcane","arcane","Arcano"],["Fire","fire","Fuego"],["Frost","frost","Escarcha"]] },
  { className:"Warlock", slug:"warlock", label:"Brujo",
    specs:[["Affliction","affliction","Aflicción"],["Demonology","demonology","Demonología"],["Destruction","destruction","Destrucción"]] },
  { className:"Monk", slug:"monk", label:"Monje",
    specs:[["Brewmaster","brewmaster","Maestro Cervecero"],["Mistweaver","mistweaver","Tejedor de Niebla"],["Windwalker","windwalker","Viajero del Viento"]] },
  { className:"Druid", slug:"druid", label:"Druida",
    specs:[["Balance","balance","Equilibrio"],["Feral","feral","Feral"],["Guardian","guardian","Guardián"],["Restoration","restoration","Restauración"]] },
  { className:"Demon Hunter", slug:"demon-hunter", label:"Cazador de Demonios",
    specs:[["Havoc","havoc","Devastación"],["Vengeance","vengeance","Venganza"]] },
  { className:"Evoker", slug:"evoker", label:"Evocador",
    specs:[["Devastation","devastation","Devastación"],["Preservation","preservation","Preservación"],["Augmentation","augmentation","Aumentación"]] },
];

// --------- Mapeo de slots
const SLOT_CANON = {
  "head":"head",
  "neck":"neck",
  "shoulder":"shoulder",
  "back":"back","cloak":"back",
  "chest":"chest",
  "wrist":"wrist",
  "hands":"hands","gloves":"hands",
  "waist":"waist","belt":"waist",
  "legs":"legs",
  "feet":"feet","boots":"feet",
  "ring":"ring","finger":"ring",
  "trinket":"trinket","abalorio":"trinket",
  "main hand":"weaponMain","one-hand":"weaponMain","one hand":"weaponMain",
  "off hand":"weaponOff",
  "two-hand":"twoHand","two hand":"twoHand"
};
const BASE_SLOTS = ["head","neck","shoulder","back","chest","wrist","hands","waist","legs","feet","weaponMain","weaponOff","twoHand"];
const pick2Names = new Set(["ring","trinket"]);

// --------- Blizzard helpers (origen del ítem)
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
  const x = await (await fetch(
    `https://${REGION}.api.blizzard.com/data/wow/journal-instance/index?namespace=static-${REGION}&locale=${LOCALE}&access_token=${tok}`
  )).json();
  instIdx.loaded = true; instIdx.list = x.instances || []; return instIdx.list;
}
async function encItems(href, tok){
  if (encCache.has(href)) return encCache.get(href);
  const e = await (await fetch(`${href}&access_token=${tok}`)).json();
  const ids = (e.items||[]).map(x=>x?.item?.id).filter(Boolean);
  const res = { ids, name: e.name||"" }; encCache.set(href,res); return res;
}
async function sourceFor(itemId, tok){
  if (srcCache.has(itemId)) return srcCache.get(itemId);
  // Busca en Journal: si cae en RAID/DUNGEON
  for (const inst of await instances(tok)){
    try{
      const d = await (await fetch(`${inst.key.href}&access_token=${tok}`)).json();
      const t = d?.instance_type?.type;
      for (const e of (d.encounters||[])){
        const det = await encItems(e.key.href, tok);
        if (det.ids.includes(itemId)){
          const src = t==="RAID" ? {type:"raid",instance:d.name,boss:det.name}
                    : t==="DUNGEON" ? {type:"mplus",dungeon:d.name}
                    : {type:"other"};
          srcCache.set(itemId, src); return src;
        }
      }
    }catch{/* continúa */}
  }
  // Intenta detectar crafteo
  try{
    const it = await (await fetch(
      `https://${REGION}.api.blizzard.com/data/wow/item/${itemId}?namespace=static-${REGION}&locale=${LOCALE}&access_token=${tok}`
    )).json();
    if (it?.preview_item && (it.preview_item.is_crafted || it.preview_item.crafted_quality || it.preview_item.crafting_reagent)){
      const src = {type:"crafted"}; srcCache.set(itemId,src); return src;
    }
  }catch{}
  const src = {type:"other"}; srcCache.set(itemId,src); return src;
}

// --------- Utilidades parse/normalización
function norm(s){ return String(s||"").trim().toLowerCase(); }

// EXTRACCIÓN ROBUSTA del itemId desde enlaces Wowhead
function parseItemIdFromHref(href){
  if (!href) return null;

  // 1) Intentar decodificar repetidamente por si viene item%253D12345 (doble-encode)
  let url = String(href);
  try {
    for (let i=0; i<3; i++){
      const prev = url;
      url = decodeURIComponent(url);
      if (url === prev) break;
    }
  } catch { /* si falla decode, seguimos con url tal cual */ }

  // 2) Buscar patrones comunes
  let m =
    url.match(/(?:\?|&)item=(\d+)/) || // ?item=12345
    url.match(/\/item\/(\d+)/)      || // /item/12345
    url.match(/item%3D(\d+)/);         // item%3D12345 (por si quedó encodeado)

  if (m) return Number(m[1]);

  // 3) Último recurso: número largo al final
  m = url.match(/(\d{5,})/);
  return m ? Number(m[1]) : null;
}

// --------- Scraper Murlok (BIS por slot)
async function fetchBisFromMurlok(classSlug, specSlug){
  const url = `https://murlok.io/${classSlug}/${specSlug}/m%2B`;
  const r = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0 (compatible; bisbot/1.0)" }});
  if (!r.ok) throw new Error(`Murlok ${classSlug}/${specSlug} -> ${r.status}`);
  const html = await r.text();
  const $ = cheerio.load(html);

  // Buscar el bloque "Best-in-Slot Gear"
  const h2s = $("h2").toArray();
  const start = h2s.find(el => norm($(el).text()).includes("best-in-slot gear"));
  if (!start) {
    // Algunas guías usan un ancla diferente; probamos un fallback suave
    const altStart = $("h2:contains('Best')").first();
    if (!altStart.length) return [];
    return extractFromSection($, altStart);
  }
  return extractFromSection($, $(start));
}

function extractFromSection($, startEl){
  const outBySlot = {}; // slotCanon -> [ids]
  let node = startEl.next();
  let currentSlot = null;

  while (node.length && node.prop("tagName") && node.prop("tagName").toLowerCase() !== "h2"){
    const tag = node.prop("tagName").toLowerCase();

    if (tag === "h3"){ // título de slot
      const raw = norm(node.text())
        .replace(/\brings\b/,'ring')
        .replace(/\btrinkets\b/,'trinket')
        .replace(/\bmain\s*hand\b/,'main hand')
        .replace(/\boff\s*hand\b/,'off hand')
        .replace(/\btwo-?\s*hand\b/,'two-hand');

      let bestKey = null;
      for (const [k,v] of Object.entries(SLOT_CANON)){
        if (raw.includes(k)){ bestKey = v; break; }
      }
      currentSlot = bestKey; // puede quedar null si no reconocemos
    } else if (currentSlot){
      // buscar links Wowhead debajo del h3 actual
      const links = node.find('a[href*="wowhead"]').toArray();
      for (const a of links){
        const href = $(a).attr("href") || "";
        const id = parseItemIdFromHref(href);
        if (!id) continue;
        if (!outBySlot[currentSlot]) outBySlot[currentSlot] = [];
        if (pick2Names.has(currentSlot.replace(/\d/g,""))){
          if (outBySlot[currentSlot].length < 2 && !outBySlot[currentSlot].includes(id)){
            outBySlot[currentSlot].push(id);
          }
        } else {
          if (outBySlot[currentSlot].length === 0) outBySlot[currentSlot].push(id);
        }
      }
    }

    node = node.next();
  }

  // Acomodar formato final
  const items = [];
  for (const [slot, ids] of Object.entries(outBySlot)){
    if (!ids?.length) continue;
    if (slot === "ring" || slot === "trinket"){
      const [a,b] = ids;
      if (a) items.push({ slot: slot==="ring"?"ring1":"trinket1", id:a });
      if (b) items.push({ slot: slot==="ring"?"ring2":"trinket2", id:b });
    } else {
      items.push({ slot, id: ids[0] });
    }
  }
  return items;
}

// --------- MAIN
async function main(){
  const blizzTok = await getBnetToken();

  const labels = {};
  const data = {};
  const order = new Map([
    ["head",1],["neck",2],["shoulder",3],["back",4],["chest",5],["wrist",6],["hands",7],["waist",8],
    ["legs",9],["feet",10],["ring1",11],["ring2",12],["trinket1",13],["trinket2",14],["weaponMain",15],["weaponOff",16],["twoHand",17]
  ]);

  for (const cl of CLASSES){
    labels[cl.className] = { label: cl.label, specs:{} };
    data[cl.className] = {};

    for (const [specName, specSlug, specLabel] of cl.specs){
      labels[cl.className].specs[specName] = specLabel;

      let items = [];
      try{
        const raw = await fetchBisFromMurlok(cl.slug, specSlug);

        // Completar origen por item (raid/mplus/crafted/other)
        for (const it of raw){
          it.source = await sourceFor(it.id, blizzTok);
        }

        items = raw.sort((a,b)=>(order.get(a.slot)||99)-(order.get(b.slot)||99));
      }catch(e){
        console.error(`Error ${cl.className}/${specName}:`, e.message);
        items = [];
      }

      data[cl.className][specName] = items;
      console.log(`OK ${cl.className}/${specName}: ${items.length} piezas`);
    }
  }

  const out = { meta:{ season:SEASON_LABEL, updated:new Date().toISOString() }, labels, data };
  fs.writeFileSync("bis-feed.js", "window.BIS_FEED = " + JSON.stringify(out, null, 2) + ";\n");
  console.log("bis-feed.js listo.");
}

main().catch(e=>{ console.error(e); process.exit(1); });
