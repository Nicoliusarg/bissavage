// scripts/build-bis-from-wcl.mjs
// Genera bis-feed.json + bis-feed.js automáticamente a partir de rankings de Warcraft Logs
// Estrategia: "más usado por los mejores logs" por slot (raid y m+)

import * as fs from "node:fs/promises";

// === CONFIG RÁPIDA ===
// Ajusta el zoneId del raid actual y la dificultad (5 = Mythic, 4 = Heroic)
const RAID_ZONE_ID = 42;           // TODO: poné el zoneId de la raid actual (WCL)
const RAID_DIFFICULTY = 5;         // 5 Mythic, 4 Heroic
const TOP_PAGES = 2;               // cuántas páginas de rankings traer por encounter/spec (1 página ~ 100)
const LAST_DAYS = 14;              // ranking window (~ últimas 2 semanas)

// Especificaciones a cubrir automáticamente. Agregá/quitá las que quieras.
const SPECS = [
  { cls: "Warrior",       spec: "Fury" },
  { cls: "Warrior",       spec: "Arms" },
  { cls: "Paladin",       spec: "Retribution" },
  { cls: "Hunter",        spec: "Marksmanship" },
  { cls: "Hunter",        spec: "Beast Mastery" },
  { cls: "Hunter",        spec: "Survival" },
  { cls: "Rogue",         spec: "Assassination" },
  { cls: "Rogue",         spec: "Outlaw" },
  { cls: "Rogue",         spec: "Subtlety" },
  { cls: "Priest",        spec: "Shadow" },
  { cls: "Death Knight",  spec: "Unholy" },
  { cls: "Death Knight",  spec: "Frost" },
  { cls: "Shaman",        spec: "Elemental" },
  { cls: "Shaman",        spec: "Enhancement" },
  { cls: "Mage",          spec: "Fire" },
  { cls: "Mage",          spec: "Arcane" },
  { cls: "Mage",          spec: "Frost" },
  { cls: "Warlock",       spec: "Affliction" },
  { cls: "Warlock",       spec: "Demonology" },
  { cls: "Warlock",       spec: "Destruction" },
  { cls: "Monk",          spec: "Windwalker" },
  { cls: "Druid",         spec: "Balance" },
  { cls: "Druid",         spec: "Feral" },
  { cls: "Demon Hunter",  spec: "Havoc" },
  { cls: "Evoker",        spec: "Augmentation" },
  { cls: "Evoker",        spec: "Devastation" }
];

// Slots de salida que usa tu front
const SLOT_MAP = {
  HEAD: "head", NECK: "neck", SHOULDERS: "shoulder", BACK: "back", CHEST: "chest",
  WRISTS: "wrist", HANDS: "hands", WAIST: "waist", LEGS: "legs", FEET: "feet",
  FINGER_1: "ring1", FINGER_2: "ring2", TRINKET_1: "trinket1", TRINKET_2: "trinket2",
  MAIN_HAND: "weaponMain", OFF_HAND: "weaponOff", TWO_HAND: "twoHand"
};

// --- helpers OAuth/GraphQL ---
async function getToken() {
  const cid = process.env.WCL_CLIENT_ID;
  const sec = process.env.WCL_CLIENT_SECRET;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cid,
    client_secret: sec
  });
  const r = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body
  });
  const t = await r.json();
  if (!t.access_token) throw new Error("No WCL token");
  return t.access_token;
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

// Encuentros de una zona (raid) — para iterar todos los bosses
const Q_ZONE = `
query($zoneId:Int!){
  worldData { zone(id:$zoneId){ encounters { id name } } }
}`;

// Rankings por encounter/clase/spec
// IMPORTANTE: el shape exacto de 'rankings' puede variar por tier; si cambia,
// ajustamos aquí los campos. Muchos tiers exponen 'rankings.rankings' con 'gear' o 'characterGear'.
const Q_RANKINGS = `
query($encounterId:Int!,$className:String!,$specName:String!,$page:Int!,$difficulty:Int!,$metric:MetricType!,$timeframe:RankingTimeRangeType!){
  worldData {
    encounter(id:$encounterId) {
      characterRankings(
        className:$className,
        specName:$specName,
        page:$page,
        difficulty:$difficulty,
        metric:$metric,
        timeframe:$timeframe
      ) {
        rankings {
          // los nombres exactos de campo varían; intentamos cubrir ambos
          gear { id slot }           # algunos tiers devuelven 'gear'
          characterGear { id slot }  # otros devuelven 'characterGear'
        }
      }
    }
  }
}`;

// Cuenta ocurrencias por slot -> ítem más frecuente
function mostUsedBySlot(allEntries) {
  const freq = {}; // slot -> itemId -> count
  for (const g of allEntries) {
    const arr = (g.gear || g.characterGear || []);
    for (const it of arr) {
      const slot = SLOT_MAP[it.slot] || null;
      if (!slot) continue;
      const id = Number(it.id);
      freq[slot] = freq[slot] || {};
      freq[slot][id] = (freq[slot][id] || 0) + 1;
    }
  }
  const top = {};
  for (const [slot, ids] of Object.entries(freq)) {
    let bestId = null, bestCount = -1;
    for (const [idStr, count] of Object.entries(ids)) {
      const id = Number(idStr);
      if (count > bestCount) { bestCount = count; bestId = id; }
    }
    if (bestId) top[slot] = bestId;
  }
  return top;
}

function asItems(topPerSlot, sourceTag) {
  const out = [];
  for (const [slot, id] of Object.entries(topPerSlot)) {
    out.push({ slot, id, source: sourceTag });
  }
  return out;
}

function sourceRaid()   { return { type: "raid",  instance: "Auto (WCL)", boss: "Top logs" }; }
function sourceMplus()  { return { type: "mplus", dungeon: "Auto (WCL)" }; }

// principal
const token = await getToken();

// 1) Recupero encounters del raid
const zone = await gql(Q_ZONE, { zoneId: RAID_ZONE_ID }, token);
const encounters = zone.worldData.zone?.encounters || [];
if (!encounters.length) console.warn("WCL: no encounters en zoneId", RAID_ZONE_ID);

// 2) Armo estructura de salida
const data = {};
for (const { cls, spec } of SPECS) data[cls] = data[cls] || {}, data[cls][spec] = [];

// 3) Para cada spec: agrego BiS por popularidad en RAID
for (const { cls, spec } of SPECS) {
  const gathered = [];
  for (const enc of encounters) {
    for (let page = 1; page <= TOP_PAGES; page++) {
      try {
        const d = await gql(Q_RANKINGS, {
          encounterId: enc.id,
          className: cls,
          specName: spec,
          page,
          difficulty: RAID_DIFFICULTY,
          metric: "dps",
          timeframe: "Historical" // o "Today","Week","Month" según prefieras
        }, token);
        const rows = d.worldData.encounter?.characterRankings?.rankings || [];
        gathered.push(...rows);
      } catch (e) {
        // si falla para algún boss/tier, seguimos
        console.warn(`WCL fallo ${cls}/${spec} enc ${enc.id} page ${page}:`, String(e).slice(0,160));
      }
    }
  }
  const top = mostUsedBySlot(gathered);
  const items = asItems(top, sourceRaid());
  data[cls][spec] = items;
}

// 4) (Opcional) Podés clonar el bloque anterior para M+ usando otra query del endpoint v1/v2 de WCL
//     y combinar resultados con etiquetas diferentes (source: {type:"mplus", dungeon:"Auto (WCL)"}).

// 5) Labels simples (podés re-usar los que ya tenés, o generar básicos)
const labels = {};
for (const { cls, spec } of SPECS) {
  labels[cls] = labels[cls] || { label: cls, specs: {} };
  labels[cls].specs[spec] = spec;
}

const out = {
  meta: { season: "Auto (WCL)", updated: new Date().toISOString() },
  labels,
  data
};

// 6) Escribo feed final para el front (igual que hoy)
await fs.writeFile("bis-feed.json", JSON.stringify(out, null, 2), "utf8");
await fs.writeFile("bis-feed.js", `window.BIS_FEED=${JSON.stringify(out)};`, "utf8");
console.log("✔ BiS auto (WCL) generado");
