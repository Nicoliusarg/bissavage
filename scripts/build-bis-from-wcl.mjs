// scripts/build-bis-from-wcl.mjs
// Genera bis-feed.json + bis-feed.js automáticamente desde Warcraft Logs
// Estrategia: ítem más usado por slot en top logs (por clase/spec)

import * as fs from "node:fs/promises";
import { URLSearchParams } from "node:url";

/* ===========================
    Config general (editable)
    =========================== */
// Dificultad de banda a procesar (4 = Heroic, 5 = Mythic, 3 = Normal)
const RAID_DIFFICULTY = 4;
// ID de la zona de banda a procesar
const RAID_ZONE_ID = 44; 
// páginas de rankings a leer por boss (1 página ~100 logs)
const TOP_PAGES = Number(process.env.WCL_TOP_PAGES || 200); 
// timeframe: "Historical" suele ser más estable
const TIMEFRAME = process.env.WCL_TIMEFRAME || "LastWeek";

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
  if(!cid || !sec) {
    warn("Faltan WCL_CLIENT_ID/SECRET");
    return null;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cid,
    client_secret: sec
  });
  try {
    const r = await fetch("https://www.warcraftlogs.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const j = await r.json();
    if(!j.access_token) {
      warn("No se pudo obtener el token de acceso de WCL. Respuesta de la API:", JSON.stringify(j));
      return null;
    }
    return j.access_token;
  } catch(e) {
    warn("Fallo al obtener el token de WCL:", String(e).slice(0, 160));
    return null;
  }
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
    if (j.errors) {
      warn("Error en la respuesta GraphQL:", JSON.stringify(j.errors));
      throw new Error(JSON.stringify(j.errors));
    }
    return j.data;
  } catch (e) {
    warn("Error al parsear JSON:", e.message);
    warn("Respuesta completa de la API:", text.slice(0, 500) + "...");
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

async function resolveZoneDetails(zoneId, token) {
  try {
    const d = await gql(Q_ZONES, {}, token);
    const zones = d?.worldData?.zones || [];
    const zone = zones.find(z => z.id === zoneId);
    if(zone) {
      log(`Zona encontrada: ${zone.name} (ID: ${zone.id})`);
      return zone;
    }
  } catch(e) {
    warn("No pude obtener detalles de la zona:", String(e).slice(0,160));
  }
  return null;
}

async function resolveLatestMPlusZone(token) {
  try {
    const d = await gql(Q_ZONES, {}, token);
    const zones = d?.worldData?.zones || [];
    // No filtrar por id < 1000 para que funcione con M+ que tengan IDs más altos.
    const withDungeons = zones.filter(z => (z.encounters||[]).length>0 && z.name.toLowerCase().includes('mythic+ season')); 
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

// cuenta ocurrencias y devuelve los más frecuentes
function mostUsedItems(entries, maxCount = 3) {
  const itemCounts = {}; // id -> { count: number, slot: string }
  for (const row of entries) {
    const gear = row?.gear || row?.characterGear || [];
    for (const item of gear) {
      const id = Number(item.id);
      if (!id) continue;
      if (!itemCounts[id]) {
        itemCounts[id] = { count: 0, slot: SLOT_MAP[item.slot] || 'unknown' };
      }
      itemCounts[id].count++;
    }
  }

  // Ordenar por count y devolver los N principales
  const sortedItems = Object.entries(itemCounts)
    .map(([id, data]) => ({ id: Number(id), count: data.count, slot: data.slot }))
    .sort((a, b) => b.count - a.count);

  return sortedItems.slice(0, maxCount);
}

// Analiza las combinaciones de abalorios y devuelve las más frecuentes
function mostUsedTrinketCombos(entries, maxCount = 3) {
    const comboCounts = {}; // "id1-id2" -> count
    for (const row of entries) {
        const gear = row?.gear || row?.characterGear || [];
        const trinkets = gear.filter(it => it.slot === 'TRINKET_1' || it.slot === 'TRINKET_2')
                               .map(it => Number(it.id))
                               .filter(id => id > 0)
                               .sort((a, b) => a - b); // ordenar para que el orden no importe
        
        if (trinkets.length === 2) {
            const comboKey = `${trinkets[0]}-${trinkets[1]}`;
            comboCounts[comboKey] = (comboCounts[comboKey] || 0) + 1;
        }
    }

    const sortedCombos = Object.entries(comboCounts)
        .sort(([, countA], [, countB]) => countB - countA)
        .slice(0, maxCount)
        .map(([key, count]) => {
            const [id1, id2] = key.split('-').map(Number);
            return { trinket1: id1, trinket2: id2, count };
        });

    return sortedCombos;
}

// Cuenta ocurrencias por slot y devuelve los N principales con su porcentaje
function getTopItemsBySlot(entries, totalEntries, maxItemsPerSlot = 3) {
    const counts = {}; // slot -> id -> count
    for (const row of entries) {
        const gear = row?.gear || row?.characterGear || [];
        for (const item of gear) {
            const slotKey = SLOT_MAP[item.slot] || null;
            if (!slotKey) continue;
            const id = Number(item.id);
            if (!id) continue;
            (counts[slotKey] ||= {})[id] = (counts[slotKey][id] || 0) + 1;
        }
    }

    const topItems = {};
    for (const [slot, itemCounts] of Object.entries(counts)) {
        const sortedItems = Object.entries(itemCounts)
            .map(([idStr, count]) => ({ id: Number(idStr), count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, maxItemsPerSlot);

        // Calcular porcentaje de uso
        const totalSlotEntries = Object.values(itemCounts).reduce((sum, count) => sum + count, 0);
        const itemsWithPercentage = sortedItems.map(item => ({
            id: item.id,
            count: item.count,
            percentage: totalSlotEntries > 0 ? (item.count / totalSlotEntries) * 100 : 0
        }));
        topItems[slot] = itemsWithPercentage;
    }
    return topItems;
}

function itemsFromTop(topPerSlot, tag){
  return Object.entries(topPerSlot).map(([slot,id])=> ({ slot, id, source: tag }));
}

function sourceRaid(difficulty, zoneName){ return { type:"raid", instance:`${zoneName} (WCL, ${difficulty})`, boss:"Top logs" }; }
function sourceMplus(zoneName){ return { type:"mplus", instance:`${zoneName} (WCL)`, boss:"Top logs" }; }

/* ===========================
    Main
    =========================== */
async function main() {
  log("Iniciando la generación de BiS desde Warcraft Logs...");
  const token = await getToken();
  if (!token) {
    warn("No se pudo obtener el token de WCL. El script se detiene.");
    return;
  }

  // Inicializamos la estructura de datos
  const data = {}; // para el archivo bis-feed.js (un solo ítem)
  const advancedData = {}; // para el archivo avanzado (top 3 ítems)
  const labels = {};
  for (const [cls, specs] of Object.entries(SPECS_BY_CLASS)) {
    labels[cls] = { label: cls, specs: {} };
    data[cls] = {};
    advancedData[cls] = {};
    for (const spec of specs) {
      labels[cls].specs[spec] = spec;
      data[cls][spec] = [];
      advancedData[cls][spec] = [];
    }
  }

  // === Obtener datos de RAID ===
  const raidZone = await resolveZoneDetails(RAID_ZONE_ID, token);
  if (raidZone) {
    let foundData = false;
    log(`Intentando buscar datos de raid en la zona ${raidZone.name} y dificultad ${RAID_DIFFICULTY}...`);
    for (const [cls, specs] of Object.entries(SPECS_BY_CLASS)) {
      for (const spec of specs) {
        const gathered = [];
        const metric = metricFor(spec);
        for (const enc of raidZone.encounters) {
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
          const top = mostUsedItems(gathered, 1);
          const advanced = getTopItemsBySlot(gathered, gathered.length);
          data[cls][spec] = [...data[cls][spec], ...itemsFromTop(top, sourceRaid(RAID_DIFFICULTY, raidZone.name))];
          advancedData[cls][spec] = [...advancedData[cls][spec], ...Object.entries(advanced).map(([slot, items]) => ({ slot, items, source: sourceRaid(RAID_DIFFICULTY, raidZone.name) }))];
        }
      }
    }
  
    if (foundData) {
      log(`OK: BiS de RAID procesado con dificultad ${RAID_DIFFICULTY}.`);
    } else {
      warn("No se encontraron datos de RAID en ninguna dificultad. Saltando paso.");
    }
  } else {
    warn("No se encontró una zona de RAID con el ID especificado. Saltando paso.");
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
          const top = mostUsedItems(gathered, 1);
          const advanced = getTopItemsBySlot(gathered, gathered.length);
          const topTrinkets = mostUsedTrinketCombos(gathered);
          data[cls][spec] = [...data[cls][spec], ...itemsFromTop(top, sourceMplus(latestMplus.name))];
          advancedData[cls][spec] = [...advancedData[cls][spec], ...Object.entries(advanced).map(([slot, items]) => ({ slot, items, source: sourceMplus(latestMplus.name) }))];
          // Agregar la combinación de abalorios
          advancedData[cls][spec].push({ slot: 'trinketCombo', items: topTrinkets.map(c => ({ id1: c.trinket1, id2: c.trinket2, count: c.count, percentage: (c.count / gathered.length) * 100 })), source: sourceMplus(latestMplus.name) });
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

  const advancedOut = {
      meta: { season: "Auto (WCL) Avanzado", updated: new Date().toISOString() },
      labels,
      data: advancedData
  };

  await fs.writeFile("bis-feed.json", JSON.stringify(out, null, 2), "utf8");
  await fs.writeFile("bis-feed.js", `window.BIS_FEED=${JSON.stringify(out)};`, "utf8");
  await fs.writeFile("bis-feed-advanced.json", JSON.stringify(advancedOut, null, 2), "utf8");
  await fs.writeFile("bis-feed-advanced.js", `window.BIS_FEED_ADVANCED=${JSON.stringify(advancedOut)};`, "utf8");
}

main().finally(() => {
  fs.writeFile("build-log.txt", logMessages.join("\n"), "utf8");
});
