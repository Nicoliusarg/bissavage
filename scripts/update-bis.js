// scripts/update-bis.js — WCL v1 (IDs correctos) + origen de ítems por Journal
// Requiere secrets: WCL_V1_KEY, BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET

import fs from "fs";
import fetch from "node-fetch";

const {
  WCL_V1_KEY,
  BLIZZARD_CLIENT_ID,
  BLIZZARD_CLIENT_SECRET,
  REGION = "us",
  LOCALE = "es_MX",
  SEASON_LABEL = "TWW S3",
  RAID_ZONE_ID = "44", // Manaforge Omega
} = process.env;

if (!WCL_V1_KEY) {
  console.error("Falta WCL_V1_KEY (API v1 key de Warcraft Logs).");
  process.exit(1);
}
if (!BLIZZARD_CLIENT_ID || !BLIZZARD_CLIENT_SECRET) {
  console.error("Faltan BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET.");
  process.exit(1);
}

const MAX_PAGES = 2;   // subí si querés más muestra
const PAUSE_MS  = 150;

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

// Slots: números de InventorySlotID y nombres variados que devuelve WCL
const SLOT_KEYS = {
  1:"head",2:"neck",3:"shoulder",15:"back",5:"chest",
  9:"wrist",10:"hands",6:"waist",7:"legs",8:"feet",
  11:"ring1",12:"ring2",13:"trinket1",14:"trinket2",
  16:"weaponMain",17:"weaponOff",21:"twoHand",22:"twoHand"
};
const SLOT_BY_TEXT = {
  head:"head", neck:"neck", shoulder:"shoulder", back:"back", chest:"chest",
  wrist:"wrist", hands:"hands", waist:"waist", legs:"legs", feet:"feet",
  finger1:"ring1", finger2:"ring2", trinket1:"trinket1", trinket2:"trinket2",
  mainhand:"weaponMain", offhand:"weaponOff", twohand:"twoHand"
};
const DESIRED = ["head","neck","shoulder","back","chest","wrist","hands","waist","legs","feet","ring1","ring2","trinket1","trinket2","weaponMain","weaponOff","twoHand"];

const metricFor = (role) => role === "healer" ? "hps" : role === "dps" ? "rdps" : "dps"; // rdps según WCL. :contentReference[oaicite:3]{index=3}
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

// ----- helpers WCL v1
async function v1(path, params={}){
  const url = new URL(`https://www.warcraftlogs.com/v1/${path}`);
  Object.entries(params).forEach(([k,v])=> url.searchParams.set(k,String(v)));
  url.searchParams.set("api_key", WCL_V1_KEY);
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`WCL v1 ${path} -> ${r.status}`);
  return r.json();
}

// Trae mapping de clases/specs (IDs numéricos)
async function getClassSpecMap(){
  const classes = await v1("classes"); // docs: usar este endpoint para obtener spec IDs. :contentReference[oaicite:4]{index=4}
  const map = new Map();
  for (const c of classes){
    const bySpec = new Map();
    for (const s of (c.specs || [])) bySpec.set(s.name, s.id);
    map.set(c.name, { id: c.id, specs: bySpec });
  }
  return map;
}

// Lista de encuentros de la zone (WCL usa su propia tabla de IDs de encounter) :contentReference[oaicite:5]{index=5}
async function getZoneEncounters(zoneId){
  const zones = await v1("zones");
  const z = zones.find(z=>Number(z.id) === Number(zoneId));
  if (!z || !z.encounters?.length) throw new Error("Zone sin encounters: "+zoneId);
  return z.encounters.map(e=>({ id:e.id, name:e.name }));
}

// rankings/encounter + includeCombatantInfo (gear)
async function fetchEncounterRankings(encId, classId, specId, metric, difficulty, page){
  return v1(`rankings/encounter/${encId}`, {
    class: classId,
    spec: specId,
    difficulty,
    metric,
    includeCombatantInfo: true,
    page
  });
}

// ----- Blizzard Journal: para etiquetar origen
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
  const u = `https://${REGION}.api.blizzard.com/data/wow/journal-instance/index?namespace=static-${REGION}&locale=${LOCALE}&access_token=${tok}`;
  const x = await (await fetch(u)).json();
  instIdx.loaded = true; instIdx.list = x.instances || [];
  return instIdx.list;
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

// Normaliza slot devuelto por WCL (num o string) → nuestro key
function normSlot(slot){
  if (slot == null) return null;
  if (typeof slot === "number") return SLOT_KEYS[slot] || null;
  if (typeof slot === "string") {
    const k = SLOT_BY_TEXT[slot.toLowerCase()];
    if (k) return k;
    // A veces vienen nombres como "Finger" sin índice: ignora.
  }
  return null;
}

// Calcula BiS por frecuencia de uso en rankings
async function buildForSpec(blizzTok, zoneId, classId, specId, role){
  const metric = metricFor(role);
  const encounters = await getZoneEncounters(zoneId);
  const freq = new Map();

  for (const diff of [5,4]) { // Mythic → Heroic
    freq.clear();

    for (const enc of encounters){
      for (let page=1; page<=MAX_PAGES; page++){
        let ranks;
        try{
          ranks = await fetchEncounterRankings(enc.id, classId, specId, metric, diff, page);
        }catch{
          break;
        }
        if (!Array.isArray(ranks) || !ranks.length) break;

        for (const r of ranks){
          for (const g of (r.gear||[])){
            const slotKey = normSlot(g.slot);
            if (!slotKey) continue;
            const key = `${slotKey}:${g.id}`;
            freq.set(key, (freq.get(key)||0) + 1);
          }
        }
        await sleep(PAUSE_MS);
      }
    }

    const out = [];
    for (const s of DESIRED){
      const best = [...freq.entries()]
        .filter(([k])=>k.startsWith(s+":"))
        .sort((a,b)=>b[1]-a[1])[0];
      if (!best) continue;
      const itemId = Number(best[0].split(":")[1]);
      const source = await sourceFor(itemId, blizzTok);
      out.push({ slot:s, id:itemId, source });
    }
    if (out.length) return out;
  }
  return [];
}

async function main(){
  const [blizzTok, classMap] = await Promise.all([getBnetToken(), getClassSpecMap()]);

  const data = {};
  const labels = {};

  for (const cl of CLASSES){
    // IDs reales de WCL v1:
    const classInfo = classMap.get(cl.className);
    if (!classInfo) { console.error("Clase no encontrada en /v1/classes:", cl.className); continue; }

    data[cl.className] = {};
    labels[cl.className] = { label: cl.label, specs:{} };

    for (const sp of cl.specs){
      labels[cl.className].specs[sp.specName] = sp.label;

      const specId = classInfo.specs.get(sp.specName);
      if (!specId) {
        console.error(`Spec no encontrada: ${cl.className}/${sp.specName}`);
        data[cl.className][sp.specName] = [];
        continue;
      }

      try{
        const items = await buildForSpec(blizzTok, Number(RAID_ZONE_ID), classInfo.id, specId, sp.role);
        console.log(`OK ${cl.className}/${sp.specName}: ${items.length} slots`);
        data[cl.className][sp.specName] = items;
      }catch(e){
        console.error(`Error ${cl.className}/${sp.specName}:`, e.message);
        data[cl.className][sp.specName] = [];
      }
    }
  }

  const out = { meta:{ season:SEASON_LABEL, updated:new Date().toISOString() }, labels, data };
  fs.writeFileSync("bis-feed.js", "window.BIS_FEED = " + JSON.stringify(out, null, 2) + ";\n");
  console.log("bis-feed.js listo.");
}

main().catch(e=>{ console.error(e); process.exit(1); });
