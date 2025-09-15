// scripts/update-bis.js
// Genera bis-feed.js con window.BIS_FEED = {...} usando Warcraft Logs (popularidad, top parses)
// y mapea origen (Raid / M+ / Crafteo) con Blizzard Journal.
// Requiere Node 18+ y node-fetch@3 (el workflow ya lo instala).
// ⚠️ Asegurate que el workflow cree un package.json con {"type":"module"} para usar "import".

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
  RAID_ZONE_ID = "44", // Manaforge por defecto (cambiá si querés otra raid)
} = process.env;

if (
  !WCL_CLIENT_ID ||
  !WCL_CLIENT_SECRET ||
  !BLIZZARD_CLIENT_ID ||
  !BLIZZARD_CLIENT_SECRET
) {
  console.error("Faltan secrets de API (WCL o Blizzard).");
  process.exit(1);
}

// ————————————————————————————————————————————————
// 🗂️ Todas las clases/specs (con rol para elegir métrica WCL)
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

// ————————————————————————————————————————————————
// 🔐 Tokens
async function getTokenWCL() {
  const res = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: WCL_CLIENT_ID,
      client_secret: WCL_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error("WCL token error " + res.status);
  return (await res.json()).access_token;
}
async function getTokenBlizzard() {
  const res = await fetch("https://oauth.battle.net/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: BLIZZARD_CLIENT_ID,
      client_secret: BLIZZARD_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error("BNet token error " + res.status);
  return (await res.json()).access_token;
}

// ————————————————————————————————————————————————
// 🧠 WCL GraphQL helper
async function gqlWCL(query, variables, token) {
  const res = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// Top rankings for a zone/spec to collect gear (difficulty Mythic=5)
const QUERY_ZONE_RANKINGS = `
query TopRankings($zone:Int!, $className:String!, $specName:String!, $metric:RankingMetric!, $page:Int){
  worldData {
    zone(id:$zone){
      name
      rankings(className:$className, specName:$specName, difficulty:5, metric:$metric, page:$page){
        rankings { gear { id slot } }
      }
    }
  }
}`;

// ————————————————————————————————————————————————
// 📚 Blizzard Journal mapping (item -> origen)
const instanceIndexCache = { loaded: false, list: [] };
const encounterItemsCache = new Map();
const itemSourceCache = new Map();

async function getInstances(blizzToken) {
  if (instanceIndexCache.loaded) return instanceIndexCache.list;
  const idx = await (
    await fetch(
      `https://${REGION}.api.blizzard.com/data/wow/journal-instance/index?namespace=static-${REGION}&locale=${LOCALE}&access_token=${blizzToken}`
    )
  ).json();
  instanceIndexCache.loaded = true;
  instanceIndexCache.list = idx.instances || [];
  return instanceIndexCache.list;
}

async function getEncounterItems(encounterHref, blizzToken) {
  if (encounterItemsCache.has(encounterHref))
    return encounterItemsCache.get(encounterHref);
  const encData = await (
    await fetch(`${encounterHref}&access_token=${blizzToken}`)
  ).json();
  const ids = (encData.items || [])
    .map((x) => x?.item?.id)
    .filter(Boolean);
  encounterItemsCache.set(encounterHref, { ids, name: encData.name || "" });
  return encounterItemsCache.get(encounterHref);
}

async function mapSourceForItem(itemId, blizzToken) {
  if (itemSourceCache.has(itemId)) return itemSourceCache.get(itemId);
  // Buscar en RAIDs/Dungeons del Journal
  const instances = await getInstances(blizzToken);
  for (const inst of instances) {
    try {
      const instData = await (
        await fetch(`${inst.key.href}&access_token=${blizzToken}`)
      ).json();
      const instType = instData?.instance_type?.type;
      if (!instData.encounters) continue;
      for (const enc of instData.encounters) {
        const detail = await getEncounterItems(enc.key.href, blizzToken);
        if (detail.ids.includes(itemId)) {
          const src =
            instType === "RAID"
              ? { type: "raid", instance: instData.name, boss: detail.name }
              : instType === "DUNGEON"
              ? { type: "mplus", dungeon: instData.name }
              : { type: "other" };
          itemSourceCache.set(itemId, src);
          return src;
        }
      }
    } catch (e) {
      /* ignorar y seguir */
    }
  }
  // Heurística de crafteo
  try {
    const it = await (
      await fetch(
        `https://${REGION}.api.blizzard.com/data/wow/item/${itemId}?namespace=static-${REGION}&locale=${LOCALE}&access_token=${blizzToken}`
      )
    ).json();
    const crafted =
      it?.preview_item &&
      (it.preview_item.is_crafted ||
        it.preview_item.crafted_quality ||
        it.preview_item.crafting_reagent);
    if (crafted) {
      const src = { type: "crafted" };
      itemSourceCache.set(itemId, src);
      return src;
    }
  } catch (e) {}
  const src = { type: "other" };
  itemSourceCache.set(itemId, src);
  return src;
}

// ————————————————————————————————————————————————
// 🧮 Build BiS by popularity
const SLOT_MAP = new Map(
  Object.entries({
    head: "head",
    neck: "neck",
    shoulder: "shoulder",
    back: "back",
    chest: "chest",
    wrist: "wrist",
    hands: "hands",
    waist: "waist",
    legs: "legs",
    feet: "feet",
    finger1: "ring1",
    finger2: "ring2",
    trinket1: "trinket1",
    trinket2: "trinket2",
    mainhand: "weaponMain",
    offhand: "weaponOff",
    twohand: "twoHand",
  })
);

const DESIRED_SLOTS = [
  "head",
  "neck",
  "shoulder",
  "back",
  "chest",
  "wrist",
  "hands",
  "waist",
  "legs",
  "feet",
  "ring1",
  "ring2",
  "trinket1",
  "trinket2",
  "weaponMain",
  "weaponOff",
  "twoHand",
];

function metricForRole(role) {
  return role === "healer" ? "hps" : "dps"; // tanks usan dps para simplificar
}

async function buildForSpec(wclTok, blizzTok, className, specName, metric) {
  const freq = new Map();

  for (const page of [1, 2, 3]) {
    const data = await gqlWCL(
      QUERY_ZONE_RANKINGS,
      { zone: Number(RAID_ZONE_ID), className, specName, metric, page },
      wclTok
    );
    const rankings = data?.worldData?.zone?.rankings?.rankings || [];
    for (const r of rankings) {
      for (const g of r.gear || []) {
        const slotRaw = (g.slot || "").toString().toLowerCase();
        const norm = SLOT_MAP.get(slotRaw);
        if (!norm) continue;
        const key = norm + ":" + g.id;
        freq.set(key, (freq.get(key) || 0) + 1);
      }
    }
  }

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
  return out;
}

async function main() {
  const [wclTok, blizzTok] = await Promise.all([
    getTokenWCL(),
    getTokenBlizzard(),
  ]);

  const data = {};
  const labels = {};

  for (const cl of CLASSES) {
    data[cl.className] = {};
    labels[cl.className] = { label: cl.label, specs: {} };

    for (const sp of cl.specs) {
      labels[cl.className].specs[sp.specName] = sp.label;

      try {
        const items = await buildForSpec(
          wclTok,
          blizzTok,
          cl.className,
          sp.specName,
          metricForRole(sp.role)
        );
        data[cl.className][sp.specName] = items;
      } catch (e) {
        console.error("Error en", cl.className, sp.specName, e.message);
        data[cl.className][sp.specName] = [];
      }
    }
  }

  const out = {
    meta: { season: SEASON_LABEL, updated: new Date().toISOString() },
    labels,
    data,
  };

  const js = "window.BIS_FEED = " + JSON.stringify(out, null, 2) + ";\n";
  fs.writeFileSync("bis-feed.js", js);
  console.log("bis-feed.js listo.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
