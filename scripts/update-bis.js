// scripts/update-bis.js — v2.2 (autodetecta zone por nombre + rdps)
import fs from "fs";
import fetch from "node-fetch";

const {
  WCL_CLIENT_ID, WCL_CLIENT_SECRET,
  BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET,
  REGION = "us", LOCALE = "es_MX",
  SEASON_LABEL = "TWW S3",
  RAID_ZONE_ID = "44",        // si no sirve, se intenta resolver por nombre
  ZONE_NAME = "Manaforge",    // autodetección por nombre (parcial, case-insensitive)
} = process.env;

if (!WCL_CLIENT_ID || !WCL_CLIENT_SECRET || !BLIZZARD_CLIENT_ID || !BLIZZARD_CLIENT_SECRET) {
  console.error("Faltan secrets de API (WCL o Blizzard).");
  process.exit(1);
}

// -------- Auth
async function token(url, body) {
  const r = await fetch(url, { method:"POST",
    headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body:new URLSearchParams(body) });
  if (!r.ok) throw new Error(url+" -> "+r.status);
  return (await r.json()).access_token;
}
const getTokenWCL = () => token("https://www.warcraftlogs.com/oauth/token",
  { grant_type:"client_credentials", client_id:WCL_CLIENT_ID, client_secret:WCL_CLIENT_SECRET });
const getTokenBlizzard = () => token("https://oauth.battle.net/token",
  { grant_type:"client_credentials", client_id:BLIZZARD_CLIENT_ID, client_secret:BLIZZARD_CLIENT_SECRET });

// -------- WCL GQL
async function gqlWCL(query, variables, tok){
  const r = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:"Bearer "+tok },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const Q_ZONES = `query { worldData { zones { id name } } }`;
const Q_ZONE_ENCS = `query($zone:Int!){ worldData { zone(id:$zone){ id name encounters{ id name } } } }`;
const Q_ENC_RANK = `
query($enc:Int!, $className:String!, $specName:String!, $metric:RankingMetric!, $diff:Int!, $page:Int){
  worldData {
    encounter(id:$enc){
      characterRankings(className:$className, specName:$specName,
                        difficulty:$diff, metric:$metric, page:$page,
                        includeCombatantInfo:true)
    }
  }
}`;

// -------- Blizzard Journal (origen)
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

// -------- Clases/spec
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

const SLOT_MAP = new Map(Object.entries({
  head:"head", neck:"neck", shoulder:"shoulder", back:"back", chest:"chest",
  wrist:"wrist", hands:"hands", waist:"waist", legs:"legs", feet:"feet",
  finger1:"ring1", finger2:"ring2", trinket1:"trinket1", trinket2:"trinket2",
  mainhand:"weaponMain", offhand:"weaponOff", twohand:"twoHand",
}));
const DESIRED_SLOTS = ["head","neck","shoulder","back","chest","wrist","hands","waist","legs","feet","ring1","ring2","trinket1","trinket2","weaponMain","weaponOff","twoHand"];

const metricFor = (role) => role==="healer" ? "hps" : "rdps";

// —— Resuelve zone: usa ID; si no tiene encounters, busca por nombre ZONE_NAME
async function resolveZoneId(wclTok){
  // intenta con el ID dado
  try{
    const z = await gqlWCL(Q_ZONE_ENCS, { zone:Number(RAID_ZONE_ID) }, wclTok);
    const encs = z?.worldData?.zone?.encounters || [];
    if (encs.length) return { id:Number(RAID_ZONE_ID), name:z.worldData.zone.name, encounters:encs };
  }catch{}
  // busca por nombre
  const all = await gqlWCL(Q_ZONES, {}, wclTok);
  const zones = all?.worldData?.zones || [];
  const found = zones.find(z => String(z.name).toLowerCase().includes(String(ZONE_NAME).toLowerCase()));
  if (!found) throw new Error("No se encontró zone por nombre: "+ZONE_NAME);
  const z2 = await gqlWCL(Q_ZONE_ENCS, { zone: Number(found.id) }, wclTok);
  const encs2 = z2?.worldData?.zone?.encounters || [];
  if (!encs2.length) throw new Error("Zone sin encounters: "+found.id+" "+found.name);
  console.log(`Zone resuelto: ${found.name} (#${found.id}) con ${encs2.length} encounters`);
  return { id:Number(found.id), name:found.name, encounters:encs2 };
}

// —— calcula BiS por spec sumando rankings de cada encounter
async function buildForSpec(wclTok, blizzTok, zone, className, specName, metric){
  for (const diff of [5,4,3,2]) {
    const freq = new Map();

    for (const enc of zone.encounters){
      let page = 1;
      while (page <= 5) {
        const d = await gqlWCL(Q_ENC_RANK, { enc:enc.id, className, specName, metric, diff, page }, wclTok);
        let raw = d?.worldData?.encounter?.characterRankings;
        try { if (typeof raw === "string") raw = JSON.parse(raw); } catch(e){ raw = null; }
        const resp = raw && typeof raw === "object" ? raw : { rankings:[], hasMorePages:false };
        const ranks = Array.isArray(resp.rankings) ? resp.rankings : [];
        if (!ranks.length) break;
        for (const r of ranks){
          for (const g of (r.gear || [])){
            const slot = SLOT_MAP.get(String(g.slot||"").toLowerCase());
            if (!slot) continue;
            const key = `${slot}:${g.id}`;
            freq.set(key, (freq.get(key)||0) + 1);
          }
        }
        if (!resp.hasMorePages) break;
        page++;
      }
    }

    const out = [];
    for (const s of DESIRED_SLOTS){
      const best = [...freq.entries()].filter(([k])=>k.startsWith(s+":")).sort((a,b)=>b[1]-a[1])[0];
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
  const [wclTok, blizzTok] = await Promise.all([getTokenWCL(), getTokenBlizzard()]);
  const zone = await resolveZoneId(wclTok);

  const data = {}, labels = {};
  for (const cl of CLASSES){
    data[cl.className] = {};
    labels[cl.className] = { label: cl.label, specs:{} };
    for (const sp of cl.specs){
      labels[cl.className].specs[sp.specName] = sp.label;
      try{
        const items = await buildForSpec(wclTok, blizzTok, zone, cl.className, sp.specName, metricFor(sp.role));
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
