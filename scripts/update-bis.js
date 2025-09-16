// scripts/update-bis.js — BIS por clase/spec desde Murlok.io (M+) + origen con Blizzard
// Requisitos:
//   - Deps: node-fetch@3, cheerio@1
//   - Secrets: BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET

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

// --------- Slots
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
  "ring":"ring","finger":"ring","rings":"ring",
  "trinket":"trinket","trinkets":"trinket","abalorio":"trinket",
  "main hand":"weaponMain","one-hand":"weaponMain","one hand":"weaponMain",
  "off hand":"weaponOff",
  "two-hand":"twoHand","two hand":"twoHand","two-hand":"twoHand"
};
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

// --------- Utils
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
function norm(s){ return String(s||"").trim().toLowerCase(); }

// IDs desde Wowhead (maneja item%3D y doble-encode)
function parseItemIdFromHref(href){
  if (!href) return null;
  let url = String(href);
  try {
    for (let i=0; i<3; i++){
      const prev = url;
      url = decodeURIComponent(url);
      if (url === prev) break;
    }
  } catch {}
  let m =
    url.match(/(?:\?|&)item=(\d+)/) ||
    url.match(/\/item\/(\d+)/) ||
    url.match(/item%3D(\d+)/);
  if (m) return Number(m[1]);
  m = url.match(/(\d{5,})/);
  return m ? Number(m[1]) : null;
}

// --------- Scraper Murlok (BIS por slot)
async function fetchBisFromMurlok(classSlug, specSlug){
  const url = `https://murlok.io/${classSlug}/${specSlug}/m%2B`;
  const r = await fetch(url, {
    headers:{
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,es-419;q=0.8",
      "Cache-Control": "no-cache"
    }
  });
  if (!r.ok) throw new Error(`Murlok ${classSlug}/${specSlug} -> ${r.status}`);
  const html = await r.text();
  const $ = cheerio.load(html);

  // 1) H2 con "Best-in-Slot Gear"
  const h2 = $("h2").filter((_,el)=> norm($(el).text()).includes("best-in-slot gear")).first();
  if (!h2.length) return []; // si cambia el título, ajustamos luego

  // 2) Todos los nodos HASTA el próximo H2 (esto es lo que fallaba con .prop('tagName'))
  const sectionNodes = h2.nextUntil("h2");
  const outBySlot = {};
  let currentSlot = null;

  sectionNodes.each((_, el) => {
    const tag = (el && el.name ? el.name.toLowerCase() : "");
    if (tag === "h3"){
      const raw = norm($(el).text())
        .replace(/\brings\b/,'ring')
        .replace(/\btrinkets\b/,'trinket')
        .replace(/\bmain\s*hand\b/,'main hand')
        .replace(/\boff\s*hand\b/,'off hand')
        .replace(/\btwo-?\s*hand\b/,'two-hand');
      let bestKey = null;
      for (const [k,v] of Object.entries(SLOT_CANON)){
        if (raw.includes(k)){ bestKey = v; break; }
      }
      currentSlot = bestKey;
    } else if (currentSlot){
      $(el).find('a[href*="wowhead"]').each((__, a) => {
        const href = $(a).attr("href") || "";
        const id = parseItemIdFromHref(href);
        if (!id) return;
        if (!outBySlot[currentSlot]) outBySlot[currentSlot] = [];
        if (pick2Names.has(currentSlot)){
          if (outBySlot[currentSlot].length < 2 && !outBySlot[currentSlot].includes(id)){
            outBySlot[currentSlot].push(id);
          }
        } else {
          if (outBySlot[currentSlot].length === 0) outBySlot[currentSlot].push(id);
        }
      });
    }
  });

  // 3) Formato final por slot
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
      // pequeña pausa para ser amables con los hosts
      await new Promise(r=>setTimeout(r,120));
    }
  }

  const out = { meta:{ season:SEASON_LABEL, updated:new Date().toISOString() }, labels, data };
  fs.writeFileSync("bis-feed.js", "window.BIS_FEED = " + JSON.stringify(out, null, 2) + ";\n");
  console.log("bis-feed.js listo.");
}

main().catch(e=>{ console.error(e); process.exit(1); });
