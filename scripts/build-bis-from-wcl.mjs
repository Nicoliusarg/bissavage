// scripts/build-bis-from-wcl.mjs
// Genera bis-feed.json + bis-feed.js automáticamente desde Warcraft Logs
// Estrategia: ítem más usado por slot en top logs (por clase/spec)

import * as fs from "node:fs/promises";
import { URLSearchParams } from "node:url";

/* ===========================
    Config general (editable)
    =========================== */
// Dificultades a intentar si no se encuentran datos. El script probará en este orden.
const RAID_DIFFICULTIES_TO_TRY = [4, 5, 3];
// páginas de rankings a leer por boss (1 página ~100 logs)
const TOP_PAGES = Number(process.env.WCL_TOP_PAGES || 20); 
// timeframe: "Historical" suele ser más estable
const TIMEFRAME = process.env.WCL_TIMEFRAME || "Historical";

/* ===========================
    Sistema de log
    =========================== */
const logMessages = [];
function log(...args) {
    const message = args.join(" ");
    const timestamp = new Date().toISOString();
    logMessages.push(`[${timestamp}] ${message}`);
    console.log(...args);
}
function warn(...args) {
    const message = args.join(" ");
    const timestamp = new Date().toISOString();
    logMessages.push(`[${timestamp}] ADVERTENCIA: ${message}`);
    console.warn(...args);
}

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
  if(!token) throw new Error("Token de acceso de WCL no encontrado");

  const r = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ query, variables })
  });

  const text = await r.text();
  try {
    const j = JSON.parse(text);
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  } catch (e) {
    warn("Error al parsear JSON:", e.message);
    warn("Respuesta completa de la API:", text.slice(0, 500) + "..."); // Limita el log para no saturar
    throw new Error(`Respuesta inválida de la API: ${e.message}`);
  }
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

async function resolveLatestRaidZone(token) {
  try {
    const d = await gql(Q_ZONES, {}, token);
    const zones = d?.worldData?.zones || [];
    const withBosses = zones.filter(z => (z.encounters||[]).length>0 && z.id>1000); // Filtra raids y no mazmorras viejas
    const latest = withBosses.sort((a,b)=> b.id - a.id)[0];
    if(latest) {
      log(`Zona de raid más reciente encontrada: ${latest.name} (ID: ${latest.id})`);
      return latest;
    }
  } catch(e) {
    warn("No pude listar zonas de RAID:", String(e).slice(0,160));
  }
  return null;
}

async function resolveLatestMPlusZone(token) {
  try {
    const d = await gql(Q_ZONES, {}, token);
    const zones = d?.worldData?.zones || [];
    const withDungeons = zones.filter(z => (z.encounters||[]).length>0 && z.id<1000); // Filtra mazmorras y no raids
    const latest = withDungeons.sort((a,b)=> b.id - a.id)[0];
    if(latest) {
      log(`Zona de Mítica+ más reciente encontrada: ${latest.name} (ID: ${latest.id})`);
      return latest;
    }
  } catch(e) {
    warn("No pude listar zonas de Mítica+:", String(e).slice(0,160));
  }
  return null;
}

const Q_RANKINGS = `
query($encounterId:Int!,$className:String!,$specName:String!,$page:Int!,$difficulty:Int!,$metric:MetricType!,$timeframe:RankingTimeRangeType!){
  worldData {
    encounter(id:$encounterId) {
      characterRankings(className:$className, specName:$specName, page:$page, difficulty:$difficulty, metric:$metric, timeframe:$timeframe) {
        rankings {
          gear { id slot }
          characterGear { id slot }
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

function sourceRaid(difficulty, zoneName){ return { type:"raid", instance:`${zoneName} (WCL, ${difficulty})`, boss:"Top logs" }; }
function sourceMplus(zoneName){ return { type:"mplus", instance:`${zoneName} (WCL)`, boss:"Top logs" }; }

/* ===========================
    Main
    =========================== */
try {
  const token = await getToken();

  // Inicializamos la estructura de datos
  const data = {};
  const labels = {};
  for (const [cls, specs] of Object.entries(SPECS_BY_CLASS)) {
    labels[cls] = { label: cls, specs: {} };
    data[cls] = {};
    for (const spec of specs) {
      labels[cls].specs[spec] = spec;
      data[cls][spec] = [];
    }
  }

  // === Obtener datos de RAID ===
  const latestRaid = await resolveLatestRaidZone(token);
  if (latestRaid) {
    let foundData = false;
    let raidDifficulty = 0;
    for (const diff of RAID_DIFFICULTIES_TO_TRY) {
      log(`Intentando buscar datos de raid en dificultad ${diff}...`);
      for (const [cls, specs] of Object.entries(SPECS_BY_CLASS)) {
        for (const spec of specs) {
          const gathered = [];
          const metric = metricFor(spec);
          for (const enc of latestRaid.encounters) {
            for (let page=1; page<=TOP_PAGES; page++) {
              try {
                const res = await gql(Q_RANKINGS, {
                  encounterId: enc.id,
                  className: cls,
                  specName: spec,
                  page,
                  difficulty: diff, 
                  metric,
                  timeframe: TIMEFRAME
                }, token);
                const rows = res?.worldData?.encounter?.characterRankings?.rankings || [];
                if (rows.length) {
                  gathered.push(...rows);
                  foundData = true;
                }
              } catch(e) {
                warn(`Rankings de RAID fallo ${cls}/${spec} enc ${enc.id} page ${page}:`, String(e).slice(0,160));
              }
            }
          }
          if (gathered.length > 0) {
            const top = mostUsedBySlot(gathered);
            data[cls][spec] = [...data[cls][spec], ...itemsFromTop(top, sourceRaid(diff, latestRaid.name))];
          }
        }
      }
      if (foundData) {
        raidDifficulty = diff;
        break;
      }
    }
  
    if (foundData) {
      log(`OK: BiS de RAID procesado con dificultad ${raidDifficulty}.`);
    } else {
      warn("No se encontraron datos de RAID en ninguna dificultad. Saltando paso.");
    }
  } else {
    warn("No se encontró una zona de RAID reciente. Saltando paso.");
  }

  // === Obtener datos de MÍTICAS+ ===
  const latestMplus = await resolveLatestMPlusZone(token);
  if (latestMplus) {
    let foundData = false;
    for (const [cls, specs] of Object.entries(SPECS_BY_CLASS)) {
      for (const spec of specs) {
        const gathered = [];
        const metric = metricFor(spec);
        for (const enc of latestMplus.encounters) {
          for (let page=1; page<=TOP_PAGES; page++) {
            try {
              const res = await gql(Q_RANKINGS, {
                encounterId: enc.id,
                className: cls,
                specName: spec,
                page,
                difficulty: 10, // Dificultad fija para M+
                metric,
                timeframe: TIMEFRAME
              }, token);
              const rows = res?.worldData?.encounter?.characterRankings?.rankings || [];
              if (rows.length) {
                gathered.push(...rows);
                foundData = true;
              }
            } catch(e) {
              warn(`Rankings de M+ fallo ${cls}/${spec} enc ${enc.id} page ${page}:`, String(e).slice(0,160));
            }
          }
        }
        if (gathered.length > 0) {
          const top = mostUsedBySlot(gathered);
          data[cls][spec] = [...data[cls][spec], ...itemsFromTop(top, sourceMplus(latestMplus.name))];
        }
      }
    }
  
    if (foundData) {
      log("OK: BiS de MÍTICAS+ procesado.");
    } else {
      warn("No se encontraron datos de Míticas+. Saltando paso.");
    }
  } else {
    warn("No se encontró una zona de Mítica+ reciente. Saltando paso.");
  }


  // meta + salida
  const out = {
    meta: { season: "Auto (WCL)", updated: new Date().toISOString() },
    labels,
    data
  };

  await fs.writeFile("bis-feed.json", JSON.stringify(out, null, 2), "utf8");
  await fs.writeFile("bis-feed.js", `window.BIS_FEED=${JSON.stringify(out)};`, "utf8");

} finally {
  await fs.writeFile("build-log.txt", logMessages.join("\n"), "utf8");
}
