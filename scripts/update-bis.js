// scripts/update-bis.js (v2: rankings por ENCOUNTER)
import fs from "fs";
import fetch from "node-fetch";

const {
  WCL_CLIENT_ID,
  WCL_CLIENT_SECRET,
  BLIZZARD_CLIENT_ID,
  BLIZZARD_CLIENT_SECRET,
  REGION = "us",
  LOCALE = "es_MX",
  SEASON_LABEL = "TWW S3",
  RAID_ZONE_ID = "44", // Manaforge Omega
} = process.env;

if (!WCL_CLIENT_ID || !WCL_CLIENT_SECRET || !BLIZZARD_CLIENT_ID || !BLIZZARD_CLIENT_SECRET) {
  console.error("Faltan secrets de API (WCL o Blizzard).");
  process.exit(1);
}

// --------------------- Auth ---------------------
async function getTokenWCL() {
  const r = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: WCL_CLIENT_ID,
      client_secret: WCL_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error("WCL token error " + r.status);
  return (await r.json()).access_token;
}
async function getTokenBlizzard() {
  const r = await fetch("https://oauth.battle.net/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: BLIZZARD_CLIENT_ID,
      client_secret: BLIZZARD_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error("BNet token error " + r.status);
  return (await r.json()).access_token;
}

// --------------------- WCL GraphQL helpers ---------------------
async function gqlWCL(query, variables, token) {
  const r = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const Q_ZONE_ENCS = `
query QZone($zone:Int!){
  worldData { zone(id:$zone){ encounters { id name } } }
}`;

const Q_ENC_RANK = `
query QEnc($enc:Int!, $className:String!, $specName:String!, $metric:RankingMetric!, $diff:Int!, $page:Int){
  worldData {
    encounter(id:$enc){
      name
      characterRankings(
        className:$className, specName:$specName,
        difficulty:$diff, metric:$metric, page:$page,
        includeCombatantInfo:true
      )
    }
  }
}`;

// --------------------- Blizzard Journal (mapping de origen) ---------------------
const instanceIndexCache = { loaded: false, list: [] };
const encounterItemsCache = new Map();
const itemSourceCache = new Map();

async function getInstances(blizzToken) {
  if (instanceIndexCache.loaded) return instanceIndexCache.list;
  const idx = await (await fetch(
    `https://${REGION}.api.blizzard.com/data/wow/journal-instance/index?namespace=static-${REGION}&locale=${LOCALE}&access_token=${blizzToken}`
  )).json();
  instanceIndexCache.loaded = true;
  instanceIndexCache.list = idx.instances || [];
  return instanceIndexCache.list;
}
async function getEncounterItems(encHref, tok) {
  if (encounterItemsCache.has(encHref)) return encounterItemsCache.get(encHref);
  const enc = await (await fetch(`${encHref}&access_token=${tok}`)).json();
  const ids = (enc.items || []).map(x => x?.item?.id).filter(Boolean);
  const res = { ids, name: enc.name || "" };
  encounterItemsCache.set(encHref, res);
  return res;
}
async function mapSourceForItem(itemId, tok) {
  if (itemSourceCache.has(itemId)) return itemSourceCache.get(itemId);
  const insts = await getInstances(tok);
  for (const inst of insts) {
    try {
      const instData = await (await fetch(`${inst.key.href}&access_token=${tok}`)).json();
      const type = instData?.instance_type?.type;
      if (!instData.encounters) continue;
      for (const e of instData.encounters) {
        const det = await getEncounterItems(e.key.href, tok);
        if (det.ids.includes(itemId)) {
          const src = type === "RAID"
            ? { type: "raid", instance: instData.name, boss: det.name }
            : type === "DUNGEON"
            ? { type: "mplus", dungeon: instData.name }
            : { type: "other" };
          itemSourceCache.set(itemId, src);
          return src;
        }
      }
    } catch {}
  }
  // heurística de crafteo
  try {
    const it = await (await fetch(
      `https://${REGION}.api.blizzard.com/data/wow/item/${itemId}?namespace=static-${REGION}&locale=${LOCALE}&access_token=${tok}`
    )).json();
    const crafted = it?.preview_item && (
      it.preview_item.is_crafted ||
      it.preview_item.crafted_quality ||
      it.preview_item.crafting_reagent
    );
    if (crafted) {
      const src = { type: "crafted" };
      itemSourceCache.set(itemId, src);
      return src;
    }
  } catch {}
  const src = { type: "other" };
  itemSourceCache.set(itemId, src);
  return src;
}

// --------------------- Esquema clases/spec ---------------------
const CLASSES = [
  { className: "Warrior", label: "Guerrero", specs: [
    { specName: "Arms", label: "Armas", role: "dps" },
    { specName: "Fury", label: "Furia", role: "dps" },
    { specName: "Protection", label: "Protección", role: "tank" },
  ]},
  { className: "Paladin", label: "Paladín", specs: [
    { specName: "Holy", label: "Sagrado", role: "healer" },
    { specName: "Protection", label: "Protección", role: "tank" },
    { specName: "Retribution", label: "Reprensión", role: "dps" },
  ]},
  { className: "Hunter", label: "Cazador", specs: [
    { specName: "Beast Mastery", label: "Maestro de Bestias", role: "dps" },
    { specName: "Marksmanship", label: "Puntería", role: "dps" },
    { specName: "Survival", label: "Supervivencia", role: "dps" },
  ]},
  { className: "Rogue", label: "Pícaro", specs: [
    { specName: "Assassination", label: "Asesinato", role: "dps" },
    { specName: "Outlaw", label: "Forajido", role: "dps" },
    { specName: "Subtlety", label: "Sutileza", role: "dps" },
  ]},
  { className: "Priest", label: "Sacerdote", specs: [
    { specName: "Discipline", label: "Disciplina", role: "healer" },
    { specName: "Holy", label: "Sagrado", role: "healer" },
    { specName: "Shadow", label: "Sombra", role: "dps" },
  ]},
  { className: "Death Knight", label: "Caballero de la Muerte", specs: [
    { specName: "Blood", label: "Sangre", role: "tank" },
    { specName: "Frost", label: "Escarcha", role: "dps" },
    { specName: "Unholy", label: "Profano", role: "dps" },
  ]},
  { className: "Shaman", label: "Chamán", specs: [
    { specName: "Elemental", label: "Elemental", role: "dps" },
    { specName: "Enhancement", label: "Mejora", role: "dps" },
    { specName: "Restoration", label: "Restauración", role: "healer" },
  ]},
  { className: "Mage", label: "Mago", specs: [
    { specName: "Arcane", label: "Arcano", role: "dps" },
    { specName: "Fire", label: "Fuego", role: "dps" },
    { specName: "Frost", label: "Escarcha", role: "dps" },
  ]},
  { className: "Warlock", label: "Brujo", specs: [
    { specName: "Affliction", label: "Aflicción", role: "dps" },
    { specName: "Demonology", label: "Demonología", role: "dps" },
    { specName: "Destruction", label: "Destrucción", role: "dps" },
  ]},
  { className: "Monk", label: "Monje", specs: [
    { specName: "Brewmaster", label: "Maestro Cervecero", role: "tank" },
    { specName: "Mistweaver", label: "Tejedor de Niebla", role: "healer" },
    { specName: "Windwalker", label: "Viajero del Viento", role: "dps" },
  ]},
  { className: "Druid", label: "Druida", specs: [
    { specName: "Balance", label: "Equilibrio", role: "dps" },
    { specName: "Feral", label: "Feral", role: "dps" },
    { specName: "Guardian", label: "Guardián", role: "tank" },
    { specName: "Restoration", label: "Restauración", role: "healer" },
  ]},
  { className: "Demon Hunter", label: "Cazador de Demonios", specs: [
    { specName: "Havoc", label: "Devastación", role: "dps" },
    { specName: "Vengeance", label: "Venganza", role: "tank" },
  ]},
  { className: "Evoker", label: "Evocador", specs: [
    { specName: "Devastation", label: "Devastación", role: "dps" },
    { specName: "Preservation", label: "Preservación", role: "healer" },
    { specName: "Augmentation", label: "Aumentación", role: "dps" },
  ]},
];

const SLOT_MAP = new Map(Object.entries({
  head: "head", neck: "neck", shoulder: "shoulder", back: "back", chest: "chest",
  wrist: "wrist", hands: "hands", waist: "waist", legs: "legs", feet: "feet",
  finger1: "ring1", finger2: "ring2", trinket1: "trinket1", trinket2: "trinket2",
  mainhand: "weaponMain", offhand: "weaponOff", twohand: "twoHand",
}));
const DESIRED_SLOTS = [
  "head","neck","shoulder","back","chest","wrist","hands","waist","legs","feet",
  "ring1","ring2","trinket1","trinket2","weaponMain","weaponOff","twoHand",
];

function metricForRole(role){ return role === "healer" ? "hps" : "dps"; }

// Suma frecuencias de items para un spec recorriendo TODOS los bosses
async function buildForSpec(wclTok, blizzTok, className, specName, metric) {
  // 1) lista de encounters del zone
  const z = await gqlWCL(Q_ZONE_ENCS, { zone: Number(RAID_ZONE_ID) }, wclTok);
  const encounters = z?.worldData?.zone?.encounters || [];
  if (!encounters.length) return [];

  // probá primero Mítico (5), si no hay nada caé a Heroico (4)
  for (const diff of [5, 4]) {
    const freq = new Map();

    for (const enc of encounters) {
      // 2) paginá rankings por encounter
      for (let page = 1; page <= 3; page++) {
        const d = await gqlWCL(Q_ENC_RANK,
          { enc: enc.id, className, specName, metric, diff, page }, wclTok);
        const obj = d?.worldData?.encounter?.characterRankings;
        const ranks = obj?.rankings || []; // GraphQL JSON scalar
        for (const r of ranks) {
          for (const g of (r.gear || [])) {
            const slotRaw = String(g.slot || "").toLowerCase();
            const norm = SLOT_MAP.get(slotRaw);
            if (!norm) continue;
            const key = norm + ":" + g.id;
            freq.set(key, (freq.get(key) || 0) + 1);
          }
        }
        // si esta página no devolvió nada, corta loop de páginas para este boss
        if (!ranks.length) break;
      }
    }

    // 3) elegí BiS por slot si hubo datos
    const out = [];
    for (const s of DESIRED_SLOTS) {
      const best = [...freq.entries()]
        .filter(([k]) => k.startsWith(s + ":"))
        .sort((a, b) => b[1] - a[1])[0];
      if (!best) continue;
      const itemId = Number(best[0].split(":")[1]);
      const source = await mapSourceForItem(itemId, blizzTok);
      out.push({ slot: s, id: itemId, source });
    }
    if (out.length) return out; // listo para este spec
  }

  return []; // sin datos en ninguna dificultad
}

async function main() {
  const [wclTok, blizzTok] = await Promise.all([getTokenWCL(), getTokenBlizzard()]);

  const data = {};
  const labels = {};

  for (const cl of CLASSES) {
    data[cl.className] = {};
    labels[cl.className] = { label: cl.label, specs: {} };

    for (const sp of cl.specs) {
      labels[cl.className].specs[sp.specName] = sp.label;
      try {
        const items = await buildForSpec(wclTok, blizzTok, cl.className, sp.specName, metricForRole(sp.role));
        data[cl.className][sp.specName] = items;
        console.log(`OK ${cl.className} / ${sp.specName}: ${items.length} slots`);
      } catch (e) {
        console.error(`Error ${cl.className} / ${sp.specName}:`, e.message);
        data[cl.className][sp.specName] = [];
      }
    }
  }

  const out = { meta: { season: SEASON_LABEL, updated: new Date().toISOString() }, labels, data };
  fs.writeFileSync("bis-feed.js", "window.BIS_FEED = " + JSON.stringify(out, null, 2) + ";\n");
  console.log("bis-feed.js listo.");
}

main().catch(e => { console.error(e); process.exit(1); });
