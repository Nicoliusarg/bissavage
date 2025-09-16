// scripts/update-bis.js — 3 fuentes: WCL v1 → Wowhead → Journal (fallback máximo ilvl)
// Requiere secrets: WCL_V1_KEY, BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET

import fs from "fs";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const {
  WCL_V1_KEY,
  BLIZZARD_CLIENT_ID,
  BLIZZARD_CLIENT_SECRET,
  REGION = "us",
  LOCALE = "es_MX",
  SEASON_LABEL = "TWW S3",
  RAID_ZONE_ID = "44", // Manaforge Omega
} = process.env;

if (!BLIZZARD_CLIENT_ID || !BLIZZARD_CLIENT_SECRET) {
  console.error("Faltan BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET"); process.exit(1);
}

const MAX_PAGES = 2;
const PAUSE_MS  = 150;
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

// ---------- UI: clases/specs
const CLASSES = [
  { className:"Warrior", label:"Guerrero", specs:[
    {specName:"Arms",label:"Armas",role:"dps"},
    {specName:"Fury",label:"Furia",role:"dps"},
    {specName:"Protection",label:"Protección",role:"tank"} ] },
  { className:"Paladin", label:"Paladín", specs:[
    {specName:"Holy",label:"Sagrado",role:"healer"},
    {specName:"Protection",label:"Protección",role:"tank"},
    {specName:"Retribution",label:"Reprensión",role:"dps"} ] },
  { className:"Hunter", label:"Cazador", specs:[
    {specName:"Beast Mastery",label:"Maestro de Bestias",role:"dps"},
    {specName:"Marksmanship",label:"Puntería",role:"dps"},
    {specName:"Survival",label:"Supervivencia",role:"dps"} ] },
  { className:"Rogue", label:"Pícaro", specs:[
    {specName:"Assassination",label:"Asesinato",role:"dps"},
    {specName:"Outlaw",label:"Forajido",role:"dps"},
    {specName:"Subtlety",label:"Sutileza",role:"dps"} ] },
  { className:"Priest", label:"Sacerdote", specs:[
    {specName:"Discipline",label:"Disciplina",role:"healer"},
    {specName:"Holy",label:"Sagrado",role:"healer"},
    {specName:"Shadow",label:"Sombra",role:"dps"} ] },
  { className:"Death Knight", label:"Caballero de la Muerte", specs:[
    {specName:"Blood",label:"Sangre",role:"tank"},
    {specName:"Frost",label:"Escarcha",role:"dps"},
    {specName:"Unholy",label:"Profano",role:"dps"} ] },
  { className:"Shaman", label:"Chamán", specs:[
    {specName:"Elemental",label:"Elemental",role:"dps"},
    {specName:"Enhancement",label:"Mejora",role:"dps"},
    {specName:"Restoration",label:"Restauración",role:"healer"} ] },
  { className:"Mage", label:"Mago", specs:[
    {specName:"Arcane",label:"Arcano",role:"dps"},
    {specName:"Fire",label:"Fuego",role:"dps"},
    {specName:"Frost",label:"Escarcha",role:"dps"} ] },
  { className:"Warlock", label:"Brujo", specs:[
    {specName:"Affliction",label:"Aflicción",role:"dps"},
    {specName:"Demonology",label:"Demonología",role:"dps"},
    {specName:"Destruction",label:"Destrucción",role:"dps"} ] },
  { className:"Monk", label:"Monje", specs:[
    {specName:"Brewmaster",label:"Maestro Cervecero",role:"tank"},
    {specName:"Mistweaver",label:"Tejedor de Niebla",role:"healer"},
    {specName:"Windwalker",label:"Viajero del Viento",role:"dps"} ] },
  { className:"Druid", label:"Druida", specs:[
    {specName:"Balance",label:"Equilibrio",role:"dps"},
    {specName:"Feral",label:"Feral",role:"dps"},
    {specName:"Guardian",label:"Guardián",role:"tank"},
    {specName:"Restoration",label:"Restauración",role:"healer"} ] },
  { className:"Demon Hunter", label:"Cazador de Demonios", specs:[
    {specName:"Havoc",label:"Devastación",role:"dps"},
    {specName:"Vengeance",label:"Venganza",role:"tank"} ] },
  { className:"Evoker", label:"Evocador", specs:[
    {specName:"Devastation",label:"Devastación",role:"dps"},
    {specName:"Preservation",label:"Preservación",role:"healer"},
    {specName:"Augmentation",label:"Aumentación",role:"dps"} ] },
];

// ---------- Slots
const SLOT_NUM = { // InventorySlotId → base
  1:"head",2:"neck",3:"shoulder",15:"back",5:"chest",
  9:"wrist",10:"hands",6:"waist",7:"legs",8:"feet",
  11:"ring",12:"ring",13:"trinket",14:"trinket",
  16:"weaponMain",17:"weaponOff",21:"twoHand",22:"twoHand"
};
const BASE_SLOTS = ["head","neck","shoulder","back","chest","wrist","hands","waist","legs","feet","weaponMain","weaponOff","twoHand"];
const RINGS = ["ring1","ring2"], TRINKS = ["trinket1","trinket2"];

function normSlot(slot){
  if (slot == null) return null;
  if (typeof slot === "number") return SLOT_NUM[slot] || null;
  const s = String(slot).toLowerCase();
  if (s.includes("finger")) return "ring";
  if (s.includes("trinket")) return "trinket";
  if (s.includes("main") && s.includes("hand")) return "weaponMain";
  if (s.includes("off")  && s.includes("hand")) return "weaponOff";
  if (s.includes("two")  && s.includes("hand")) return "twoHand";
  if (["head","neck","shoulder","back","chest","wrist","hands","waist","legs","feet"].includes(s)) return s;
  return null;
}

// ---------- Blizzard Journal (token + helpers)
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
  const res = { ids, name: e.name||"" };
  encCache.set(href,res); return res;
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
    }catch{}
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

// ---------- WCL v1 (si hay key)
async function v1(path, params={}){
  const url = new URL(`https://www.warcraftlogs.com/v1/${path}`);
  Object.entries(params).forEach(([k,v])=> url.searchParams.set(k,String(v)));
  url.searchParams.set("api_key", WCL_V1_KEY);
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`WCL v1 ${path} -> ${r.status}`);
  return r.json();
}

async function getClassSpecMap(){
  const classes = await v1("classes");
  const map = new Map();
  for (const c of classes){
    const bySpec = new Map();
    for (const s of (c.specs||[])) bySpec.set(s.name, s.id);
    map.set(c.name, { id: c.id, specs: bySpec });
  }
  return map;
}
async function getZoneEncounters(zoneId){
  const zones = await v1("zones");
  const z = zones.find(z=>Number(z.id) === Number(zoneId));
  if (!z || !z.encounters?.length) throw new Error("Zone sin encounters: "+zoneId);
  return z.encounters.map(e=>({ id:e.id, name:e.name }));
}
function metricForV1(role){ return role==="healer" ? "hps" : "dps"; }

async function bisFromWcl(blizzTok, zoneId, classId, specId, role){
  const metric = metricForV1(role);
  const encounters = await getZoneEncounters(zoneId);
  const freq = new Map(); // key `${slot}:${id}`

  for (const diff of [5,4]){
    freq.clear();
    for (const enc of encounters){
      for (let page=1; page<=MAX_PAGES; page++){
        let ranks;
        try{
          ranks = await v1(`rankings/encounter/${enc.id}`, {
            zone: Number(zoneId),
            class: Number(classId),
            spec:  Number(specId),
            difficulty: diff,
            metric,
            includeCombatantInfo: true,
            page
          });
        }catch{ break; }
        if (!Array.isArray(ranks) || !ranks.length) break;
        for (const r of ranks){
          for (const g of (r.gear||[])){
            const slotKey = normSlot(g.slot);
            const id = Number(g.id);
            if (!slotKey || !id) continue;
            const key = `${slotKey}:${id}`;
            freq.set(key, (freq.get(key)||0)+1);
          }
        }
        await sleep(PAUSE_MS);
      }
    }

    const pickTop = (prefix, n=1) => {
      const arr = [...freq.entries()].filter(([k])=>k.startsWith(prefix+":"))
        .sort((a,b)=>b[1]-a[1]).map(([k])=>Number(k.split(":")[1]));
      return [...new Set(arr)].slice(0,n);
    };

    const out = [];
    for (const s of BASE_SLOTS){
      const best = pickTop(s,1)[0];
      if (best) out.push({ slot:s, id:best, source: await sourceFor(best, blizzTok) });
    }
    const rings = pickTop("ring",2), trinks = pickTop("trinket",2);
    if (rings[0]) out.push({ slot:"ring1", id:rings[0], source: await sourceFor(rings[0], blizzTok) });
    if (rings[1]) out.push({ slot:"ring2", id:rings[1], source: await sourceFor(rings[1], blizzTok) });
    if (trinks[0]) out.push({ slot:"trinket1", id:trinks[0], source: await sourceFor(trinks[0], blizzTok) });
    if (trinks[1]) out.push({ slot:"trinket2", id:trinks[1], source: await sourceFor(trinks[1], blizzTok) });

    if (out.length) return out;
  }
  return [];
}

// ---------- Wowhead scraping (map de URLs por spec)
// TIP: pegá la URL de la sección “Best in Slot” de cada guía (EN o ES).
const WOWHEAD_BIS_URL = {
  // Paladin
  "Paladin|Retribution": "https://www.wowhead.com/guide/classes/paladin/retribution/dps-gear-and-best-in-slot",
  "Paladin|Holy":        "https://www.wowhead.com/guide/classes/paladin/holy/healer-gear-and-best-in-slot",
  "Paladin|Protection":  "https://www.wowhead.com/guide/classes/paladin/protection/tank-gear-and-best-in-slot",
  // Mage
  "Mage|Fire":           "https://www.wowhead.com/guide/classes/mage/fire/dps-gear-and-best-in-slot",
  "Mage|Frost":          "https://www.wowhead.com/guide/classes/mage/frost/dps-gear-and-best-in-slot",
  "Mage|Arcane":         "https://www.wowhead.com/guide/classes/mage/arcane/dps-gear-and-best-in-slot",
  // Warrior
  "Warrior|Arms":        "https://www.wowhead.com/guide/classes/warrior/arms/dps-gear-and-best-in-slot",
  "Warrior|Fury":        "https://www.wowhead.com/guide/classes/warrior/fury/dps-gear-and-best-in-slot",
  "Warrior|Protection":  "https://www.wowhead.com/guide/classes/warrior/protection/tank-gear-and-best-in-slot",
  // TODO: agregá el resto (Rogue, Priest, DK, Shaman, Warlock, Monk, Druid, DH, Evoker)
};

function extractItemId(href){
  if (!href) return null;
  // acepta /item=XXXX o /wow/es/item=XXXX...
  const m = href.match(/item=(\d+)/);
  return m ? Number(m[1]) : null;
}

async function bisFromWowhead(blizzTok, className, specName){
  const url = WOWHEAD_BIS_URL[`${className}|${specName}`];
  if (!url) return []; // sin URL → no intento
  const res = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0" }});
  if (!res.ok) return [];
  const html = await res.text();
  const $ = cheerio.load(html);

  // Heurística: buscar tablas/listas dentro del bloque de “Best in Slot”
  // Wowhead varía el markup; tomamos los links de items por sección con el slot en el texto cercano
  const candidates = [];
  $("a[href*='item=']").each((i,el)=>{
    const href = $(el).attr("href");
    const id = extractItemId(href);
    if (!id) return;
    // miramos texto cercano para inferir slot
    const text = ($(el).text()||"").toLowerCase();
    const ctx  = ($(el).closest("tr,li,p,div").text()||"").toLowerCase();
    const blob = text + " " + ctx;
    let slot = null;
    if (/\bhead\b/.test(blob)) slot = "head";
    else if (/\bneck|amulet|collar\b/.test(blob)) slot = "neck";
    else if (/\bshoulder\b/.test(blob)) slot = "shoulder";
    else if (/\bback|cloak|capa\b/.test(blob)) slot = "back";
    else if (/\bchest|pecho\b/.test(blob)) slot = "chest";
    else if (/\bwrist|muñec/.test(blob)) slot = "wrist";
    else if (/\bhands|guantes\b/.test(blob)) slot = "hands";
    else if (/\bwaist|cintur/.test(blob)) slot = "waist";
    else if (/\blegs|piernas\b/.test(blob)) slot = "legs";
    else if (/\bfeet|botas\b/.test(blob)) slot = "feet";
    else if (/\bring\b/.test(blob)) slot = "ring";
    else if (/\btrinket|abalorio\b/.test(blob)) slot = "trinket";
    else if (/\bmain hand\b/.test(blob)) slot = "weaponMain";
    else if (/\boff hand\b/.test(blob)) slot = "weaponOff";
    else if (/\btwo-?hand/.test(blob)) slot = "twoHand";
    if (slot) candidates.push({ slot, id });
  });

  // Agrupamos por slot y nos quedamos con 1 (o 2 para rings/trinkets)
  const bySlot = new Map();
  for (const c of candidates){
    const arr = bySlot.get(c.slot) || [];
    if (!arr.includes(c.id)) arr.push(c.id);
    bySlot.set(c.slot, arr);
  }

  const out = [];
  for (const s of BASE_SLOTS){
    const id = bySlot.get(s)?.[0];
    if (id) out.push({ slot:s, id, source: await sourceFor(id, blizzTok) });
  }
  const r = bySlot.get("ring") || [];
  const t = bySlot.get("trinket") || [];
  if (r[0]) out.push({ slot:"ring1", id:r[0], source: await sourceFor(r[0], blizzTok) });
  if (r[1]) out.push({ slot:"ring2", id:r[1], source: await sourceFor(r[1], blizzTok) });
  if (t[0]) out.push({ slot:"trinket1", id:t[0], source: await sourceFor(t[0], blizzTok) });
  if (t[1]) out.push({ slot:"trinket2", id:t[1], source: await sourceFor(t[1], blizzTok) });

  return out;
}

// ---------- Journal fallback: pick máximo ilvl por slot de la raid
async function bisFromJournal(blizzTok){
  // Buscamos en todos los instances y quedamos con los que son de tipo RAID,
  // luego por encuentro sacamos items y nos quedamos con el ilvl máximo por slot.
  const items = new Map(); // slot -> {id, ilvl}
  const list = await instances(blizzTok);
  for (const inst of list){
    try{
      const data = await (await fetch(`${inst.key.href}&access_token=${blizzTok}`)).json();
      if (data?.instance_type?.type !== "RAID") continue;
      for (const e of (data.encounters||[])){
        const det = await encItems(e.key.href, blizzTok);
        for (const id of det.ids){
          // consultamos el item para ver su media de ilvl y slot aproximado
          try{
            const it = await (await fetch(
              `https://${REGION}.api.blizzard.com/data/wow/item/${id}?namespace=static-${REGION}&locale=${LOCALE}&access_token=${blizzTok}`
            )).json();
            const name = it?.name || "";
            const hint = name.toLowerCase();
            let slot = null;
            if (/\bhead\b/.test(hint)) slot="head";
            else if (/\bneck\b/.test(hint)) slot="neck";
            else if (/\bshoulder\b/.test(hint)) slot="shoulder";
            else if (/\bcloak|back\b/.test(hint)) slot="back";
            else if (/\bchest\b/.test(hint)) slot="chest";
            else if (/\bwrist\b/.test(hint)) slot="wrist";
            else if (/\bhands\b/.test(hint)) slot="hands";
            else if (/\bwaist\b/.test(hint)) slot="waist";
            else if (/\blegs\b/.test(hint)) slot="legs";
            else if (/\bfeet\b/.test(hint)) slot="feet";
            else if (/\bring\b/.test(hint)) slot="ring";
            else if (/\btrinket\b/.test(hint)) slot="trinket";
            else if (/\bmain hand\b/.test(hint)) slot="weaponMain";
            else if (/\boff hand\b/.test(hint)) slot="weaponOff";
            else if (/\btwo-?hand\b/.test(hint)) slot="twoHand";
            if (!slot) continue;

            const ilvl = it?.preview_item?.level?.value || 0;
            const current = items.get(slot);
            if (!current || ilvl > current.ilvl) items.set(slot, { id, ilvl });
          }catch{}
        }
      }
    }catch{}
  }
  const out = [];
  for (const s of BASE_SLOTS){
    const v = items.get(s);
    if (v) out.push({ slot:s, id:v.id, source:{type:"raid"} });
  }
  // duplicamos ring/trinket si no hubo 2 (mejor que vacío)
  const ring = items.get("ring"); const tr = items.get("trinket");
  if (ring) { out.push({slot:"ring1", id:ring.id, source:{type:"raid"}});
             out.push({slot:"ring2", id:ring.id, source:{type:"raid"}}); }
  if (tr)   { out.push({slot:"trinket1", id:tr.id, source:{type:"raid"}});
             out.push({slot:"trinket2", id:tr.id, source:{type:"raid"}}); }
  return out;
}

// ---------- main
async function main(){
  const blizzTok = await getBnetToken();

  let classMap = null;
  if (WCL_V1_KEY) {
    try { classMap = await getClassSpecMap(); }
    catch { classMap = null; }
  }

  const data = {};
  const labels = {};

  for (const cl of CLASSES){
    data[cl.className] = {};
    labels[cl.className] = { label: cl.label, specs:{} };

    for (const sp of cl.specs){
      labels[cl.className].specs[sp.specName] = sp.label;

      // 1) WCL v1
      let out = [];
      if (classMap){
        const c = classMap.get(cl.className);
        const specId = c?.specs?.get(sp.specName);
        if (c?.id && specId){
          try { out = await bisFromWcl(blizzTok, Number(RAID_ZONE_ID), c.id, specId, sp.role); }
          catch {}
        }
      }

      // 2) Wowhead si no hubo suerte
      if (!out.length){
        try { out = await bisFromWowhead(blizzTok, cl.className, sp.specName); }
        catch {}
      }

      // 3) Journal (máximo ilvl) si todavía está vacío
      if (!out.length){
        try { out = await bisFromJournal(blizzTok); }
        catch {}
      }

      data[cl.className][sp.specName] = out;
      console.log(`${cl.className}/${sp.specName}: ${out.length} piezas`);
    }
  }

  const out = { meta:{ season:SEASON_LABEL, updated:new Date().toISOString() }, labels, data };
  fs.writeFileSync("bis-feed.js", "window.BIS_FEED = " + JSON.stringify(out, null, 2) + ";\n");
  console.log("bis-feed.js listo.");
}

main().catch(e=>{ console.error(e); process.exit(1); });
