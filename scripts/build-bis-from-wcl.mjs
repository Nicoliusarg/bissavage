// scripts/build-bis-from-wcl.mjs
// Genera bis-feed.json + bis-feed.js automáticamente desde Warcraft Logs
// Estrategia: ítem más usado por slot en top logs (por clase/spec)

import * as fs from "node:fs/promises";

/* ===========================
   Config general (editable)
   =========================== */
// dificultad del raid: 5 = Mythic, 4 = Heroic
const RAID_DIFFICULTY = Number(process.env.WCL_RAID_DIFFICULTY || 5);
// páginas de rankings a leer por boss (1 página ~100 logs)
const TOP_PAGES = Number(process.env.WCL_TOP_PAGES || 2);
// timeframe: "Historical" suele ser más estable
const TIMEFRAME = process.env.WCL_TIMEFRAME || "Historical";

/* ===========================
   Especificaciones (todas)
   =========================== */
const SPECS_BY_CLASS = {
  "Death Knight": ["Blood","Frost","Unholy"],
  "Demon Hunter": ["Havoc","Vengeance"],
  "Druid": ["Balance","Feral","Guardian","Restoration"],
  "Evoker": ["Augmentation","Devastation","Preservation"],
  "Hunter": ["Beast Mastery","Marksmanship","Survival"],
  "Mage": ["Arcane","Fire","Frost"],
  "Monk": ["Brewmaster","Mistweaver","Windwalker"],
  "Paladin": ["Holy","Protection","Retribution"],
  "Priest": ["Discipline","Holy","Shadow"],
  "Rogue": ["Assassination","Outlaw","Subtlety"],
  "Shaman": ["Elemental","Enhancement","Restoration"],
  "Warlock": ["Affliction","Demonology","Destruction"],
  "Warrior": ["Arms","Fury","Protection"],
};

// rol -> métrica para WCL
const HEALER_SPECS = new Set([
  "Restoration","Holy","Discipline","Mistweaver","Preservation"
]);
function metricFor(specName){
  return HEALER_SPECS.has(specName) ? "hps" : "dps";
}

/* ===========================
   Mapeo de slots → front
   =========================== */
const SLOT_MAP = {
  HEAD: "head", NECK: "neck", SHOULDERS: "shoulder", BACK: "back", CHEST: "chest",
  WRISTS: "wrist", HANDS: "hands", WAIST: "waist", LEGS: "legs", FEET: "feet",
  FINGER_1: "ring1", FINGER_2: "ring2", TRINKET_1: "trinket1", TRINKET_2: "trinket2",
  MAIN_HAND: "weaponMain", OFF_HAND: "weaponOff", TWO_HAND: "twoHand"
};

/* ===========================
   Helpers OAuth/GraphQL WCL
   =========================== */
async function getToken() {
  const cid = process.env.WCL_CLIENT_ID;
  const sec = process.env.WCL_CLIENT_SECRET;
  if(!cid || !sec) throw new Error("Faltan WCL_CLIENT_ID/SECRET");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cid,
    client_secret: sec
  });
  const r = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const j = await r.json();
  if(!j.access_token) throw new Error("No WCL token");
  return j.access_token;
}

async function gql(query, variables, token) {
  const r = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

/* ===========================
   Descubrimiento del raid
   =========================== */
// lista de zonas -> elijo la más reciente con encuentros
const Q_ZONES = `query{
  worldData {
    zones { id name encounters { id name } }
  }
}`;

const Q_ZONE = `query($zoneId:Int!){
  worldData { zone(id:$zoneId){ encounters { id name } } }
}`;

async function resolveRaidZoneId(token){
  // si te pasan uno por env, usalo
  const fromEnv = Number(process.env.WCL_RAID_ZONE_ID || 0);
  if (fromEnv) return fromEnv;
  try{
    const d = await gql(Q_ZONES, {}, token);
    const zones = d?.worldData?.zones || [];
    const withBosses = zones.filter(z => (z.encounters||[]).length>0);
    const latest = withBosses.sort((a,b)=> b.id - a.id)[0];
    if(latest) return latest.id;
  }catch(e){
    console.warn("No pude listar zonas:", String(e).slice(0,160));
  }
  return 0; // si 0, luego fall-back igual generará estructura vacía
}

/* ===========================
   Rankings y gear por boss
   =========================== */
const Q_RANKINGS = `
query($encounterId:Int!,$className:String!,$specName:String!,$page:Int!,$difficulty:Int!,$metric:MetricType!,$timeframe:RankingTimeRangeType!){
  worldData {
    encounter(id:$encounterId) {
      characterRankings(className:$className, specName:$specName, page:$page, difficulty:$difficulty, metric:$metric, timeframe:$timeframe) {
        rankings {
          gear { id slot }           # algunos tiers
          characterGear { id slot }  # otros tiers
        }
      }
    }
  }
}`;

// cuenta ocurrencias por slot y devuelve el id más frecuente
function mostUsedBySlot(entries) {
  const freq = {}; // slot -> id -> count
  for (const row of entries) {
    const gear = row?.gear || row?.characterGear || [];
    for (const it of gear) {
      const slotKey = SLOT_MAP[it.slot] || null;
      if (!slotKey) continue;
      const id = Number(it.id);
      if (!id) continue;
      (freq[slotKey] ||= {})[id] = (freq[slotKey][id] || 0) + 1;
    }
  }
  const top = {};
  for (const [slot, ids] of Object.entries(freq)) {
    let bestId=null, bestCount=-1;
    for (const [idStr, count] of Object.entries(ids)) {
      const id = Number(idStr);
      if (count > bestCount) { bestCount=count; bestId=id; }
    }
    if (bestId) top[slot] = bestId;
  }
  return top;
}

function itemsFromTop(topPerSlot, tag){
  return Object.entries(topPerSlot).map(([slot,id])=> ({ slot, id, source: tag }));
}

function sourceRaid(){ return { type:"raid", instance:"Auto (WCL)", boss:"Top logs" }; }

/* ===========================
   Main
   =========================== */
const token = await getToken();
let zoneId = await resolveRaidZoneId(token);
if (!zoneId) {
  console.warn("No pude resolver zoneId automáticamente. Podés setear WCL_RAID_ZONE_ID en el workflow.");
}

// fetch encounters
let encounters = [];
if (zoneId) {
  try {
    const d = await gql(Q_ZONE, { zoneId }, token);
    encounters = d?.worldData?.zone?.encounters || [];
  } catch(e) {
    console.warn("Error obteniendo encounters:", String(e).slice(0,160));
  }
}

const data = {};
const labels = {};
for (const [cls, specs] of Object.entries(SPECS_BY_CLASS)) {
  labels[cls] = { label: cls, specs: {} };
  data[cls] = {};
  for (const spec of specs) {
    labels[cls].specs[spec] = spec;
    data[cls][spec] = [];

    if (!encounters.length) continue; // sin raid resuelto, dejamos vacío

    const gathered = [];
    const metric = metricFor(spec);
    for (const enc of encounters) {
      for (let page=1; page<=TOP_PAGES; page++) {
        try {
          const res = await gql(Q_RANKINGS, {
            encounterId: enc.id,
            className: cls,
            specName: spec,
            page,
            difficulty: RAID_DIFFICULTY,
            metric,
            timeframe: TIMEFRAME
          }, token);
          const rows = res?.worldData?.encounter?.characterRankings?.rankings || [];
          if (rows.length) gathered.push(...rows);
        } catch(e) {
          console.warn(`Rankings fallo ${cls}/${spec} enc ${enc.id} page ${page}:`, String(e).slice(0,160));
        }
      }
    }

    const top = mostUsedBySlot(gathered);
    const items = itemsFromTop(top, sourceRaid());
    data[cls][spec] = items;
  }
}

// meta + salida
const out = {
  meta: { season: "Auto (WCL)", updated: new Date().toISOString() },
  labels,
  data
};

await fs.writeFile("bis-feed.json", JSON.stringify(out, null, 2), "utf8");
await fs.writeFile("bis-feed.js", `window.BIS_FEED=${JSON.stringify(out)};`, "utf8");
console.log("OK: BiS (WCL) generado. zoneId =", zoneId, ", encounters =", encounters.length);
