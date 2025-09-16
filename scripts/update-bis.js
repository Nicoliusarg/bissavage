// scripts/update-bis.js — BIS por clase/spec desde Murlok.io (M+) + origen con Blizzard
// Requiere: BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET
// Deps: node-fetch@3, cheerio@1

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
  "head":"head","neck":"neck","shoulder":"shoulder","back":"back","chest":"chest","wrist":"wrist","hands":"hands",
  "waist":"waist","legs":"legs","feet":"feet","ring":"ring","trinket":"trinket","main hand":"weaponMain",
  "off hand":"weaponOff","two-hand":"twoHand","two hand":"twoHand","one-hand":"weaponMain","one hand":"weaponMain",
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
    }catch{/* sigue */}
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

// --------- Scraper Murlok (BIS por slot)
function parseItemIdFromHref(href){
  // wowhead.com/item=XXXX ... devuelve XXXX
  const m = /[?&/]item=(\d+)/.exec(href) || /\/item\/(\d+)/.exec(href) || /item=(\d+)/.exec(href);
  return m ? Number(m[1]) : null;
}
function norm(s){ return String(s||"").trim().toLowerCase(); }

async function fetchBisFromMurlok(classSlug, specSlug){
  const url = `https://murlok.io/${classSlug}/${specSlug}/m%2B`;
  const r = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0 (compatible; bisbot/1.0)" }});
  if (!r.ok) throw new Error(`Murlok ${classSlug}/${specSlug} -> ${r.status}`);
  const html = await r.text();
  const $ = cheerio.load(html);

  // Ubicamos el bloque "Best-in-Slot Gear"
  const h2s = $("h2").toArray();
  const start = h2s.find(el => norm($(el).text()).includes("best-in-slot gear"));
  if (!start) return {}; // sin sección BIS (raro)
  const out = {}; // slotName -> [itemId,itemId2?]

  // Recorremos hasta el próximo h2
  let node = $(start).next();
  let currentSlot = null;

  while (node.length && node.prop("tagName") && node.prop("tagName").toLowerCase() !== "h2"){
    const tag = node.prop("tagName").toLowerCase();
    if (tag === "h3"){ // título de slot
      const slotTitle = norm(node.text()); // e.g. "head", "ring", "main hand"
      // normalizamos contra SLOT_CANON
      let bestKey = null;
      for (const [k,v] of Object.entries(SLOT_CANON)){
        if (slotTitle.includes(k)){ bestKey = v; break; }
      }
      currentSlot = bestKey; // puede ser null si no reconocemos
    }else if (currentSlot){
      // buscar links wowhead debajo (primeros 1–2 ítems)
      const links = node.find('a[href*="wowhead.com"]').toArray();
      for (const a of links){
        const href = $(a).attr("href") || "";
        const id = parseItemIdFromHref(href);
        if (!id) continue;
        if (!out[currentSlot]) out[currentSlot] = [];
        // para ring/trinket queremos dos, para el resto sólo uno
        if (pick2Names.has(currentSlot.replace(/\d/g,""))){
          if (out[currentSlot].length < 2 && !out[currentSlot].includes(id)) out[currentSlot].push(id);
        } else {
          if (out[currentSlot].length === 0) out[currentSlot].push(id);
        }
      }
    }
    node = node.next();
  }

  // Estructura final por slot canonizado
  // - ring -> ring1, ring2 ; trinket -> trinket1, trinket2
  const items = [];
  for (const [slot, ids] of Object.entries(out)){
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

  for (const cl of CLASSES){
    labels[cl.className] = { label: cl.label, specs:{} };
    data[cl.className] = {};

    for (const [specName, specSlug, specLabel] of cl.specs){
      labels[cl.className].specs[specName] = specLabel;

      let items = [];
      try{
        const raw = await fetchBisFromMurlok(cl.slug, specSlug);
        // Completar origen por item (raid/m+/crafted/other)
        for (const it of raw){
          it.source = await sourceFor(it.id, blizzTok);
        }
        // Asegurar orden por prioridad visual de slots
        const order = new Map([
          ["head",1],["neck",2],["shoulder",3],["back",4],["chest",5],["wrist",6],["hands",7],["waist",8],
          ["legs",9],["feet",10],["ring1",11],["ring2",12],["trinket1",13],["trinket2",14],["weaponMain",15],["weaponOff",16],["twoHand",17]
        ]);
        items = raw.sort((a,b)=>(order.get(a.slot)||99)-(order.get(b.slot)||99));
      }catch(e){
        console.error(`Murlok fallo ${cl.className}/${specName}:`, e.message);
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
