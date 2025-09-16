// scripts/update-bis.js — Estrategia B (WCL v2) + fallback v1 + rescate Journal
// Requiere:
//   - WCL_CLIENT_ID, WCL_CLIENT_SECRET  (v2 OAuth)
//   - WCL_V1_KEY                        (v1 API key)  [fallback]
//   - BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET      (Journal / origen)
// YAML: recuerda el paso "Enable ES modules" (package.json { "type": "module" })

import fs from "fs";
import fetch from "node-fetch";

const {
  // WCL v2
  WCL_CLIENT_ID,
  WCL_CLIENT_SECRET,
  // WCL v1 (fallback)
  WCL_V1_KEY,
  // Blizzard
  BLIZZARD_CLIENT_ID,
  BLIZZARD_CLIENT_SECRET,
  // Config
  REGION = "us",
  LOCALE = "es_MX",
  SEASON_LABEL = "TWW S3",
  RAID_ZONE_ID = "44", // Manaforge Omega (WCL zone id)
} = process.env;

const MAX_PAGES = 2;   // páginas por boss
const PAUSE_MS  = 150; // antirate-limit

// -------------------- Helpers base
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const metricFor = (role)=> role==="healer" ? "hps" : "dps"; // simple y universal

// -------------------- Clases/specs (labels ES)
const CLASSES = [
  { className:"Warrior", label:"Guerrero", specs:[
    {specName:"Arms",label:"Armas",role:"dps"},
    {specName:"Fury",label:"Furia",role:"dps"},
    {specName:"Protection",label:"Protección",role:"tank"},
  ]},
  { className:"Paladin", label:"Paladín", specs:[
    {specName:"Holy",label:"Sagrado",role:"healer"},
    {specName:"Protection",label:"Protección",role:"tank"},
    {specName:"Retribution",label:"Reprensión",role:"dps"},
  ]},
  { className:"Hunter", label:"Cazador", specs:[
    {specName:"Beast Mastery",label:"Maestro de Bestias",role:"dps"},
    {specName:"Marksmanship",label:"Puntería",role:"dps"},
    {specName:"Survival",label:"Supervivencia",role:"dps"},
  ]},
  { className:"Rogue", label:"Pícaro", specs:[
    {specName:"Assassination",label:"Asesinato",role:"dps"},
    {specName:"Outlaw",label:"Forajido",role:"dps"},
    {specName:"Subtlety",label:"Sutileza",role:"dps"},
  ]},
  { className:"Priest", label:"Sacerdote", specs:[
    {specName:"Discipline",label:"Disciplina",role:"healer"},
    {specName:"Holy",label:"Sagrado",role:"healer"},
    {specName:"Shadow",label:"Sombra",role:"dps"},
  ]},
  { className:"Death Knight", label:"Caballero de la Muerte", specs:[
    {specName:"Blood",label:"Sangre",role:"tank"},
    {specName:"Frost",label:"Escarcha",role:"dps"},
    {specName:"Unholy",label:"Profano",role:"dps"},
  ]},
  { className:"Shaman", label:"Chamán", specs:[
    {specName:"Elemental",label:"Elemental",role:"dps"},
    {specName:"Enhancement",label:"Mejora",role:"dps"},
    {specName:"Restoration",label:"Restauración",role:"healer"},
  ]},
  { className:"Mage", label:"Mago", specs:[
    {specName:"Arcane",label:"Arcano",role:"dps"},
    {specName:"Fire",label:"Fuego",role:"dps"},
    {specName:"Frost",label:"Escarcha",role:"dps"},
  ]},
  { className:"Warlock", label:"Brujo", specs:[
    {specName:"Affliction",label:"Aflicción",role:"dps"},
    {specName:"Demonology",label:"Demonología",role:"dps"},
    {specName:"Destruction",label:"Destrucción",role:"dps"},
  ]},
  { className:"Monk", label:"Monje", specs:[
    {specName:"Brewmaster",label:"Maestro Cervecero",role:"tank"},
    {specName:"Mistweaver",label:"Tejedor de Niebla",role:"healer"},
    {specName:"Windwalker",label:"Viajero del Viento",role:"dps"},
  ]},
  { className:"Druid", label:"Druida", specs:[
    {specName:"Balance",label:"Equilibrio",role:"dps"},
    {specName:"Feral",label:"Feral",role:"dps"},
    {specName:"Guardian",label:"Guardián",role:"tank"},
    {specName:"Restoration",label:"Restauración",role:"healer"},
  ]},
  { className:"Demon Hunter", label:"Cazador de Demonios", specs:[
    {specName:"Havoc",label:"Devastación",role:"dps"},
    {specName:"Vengeance",label:"Venganza",role:"tank"},
  ]},
  { className:"Evoker", label:"Evocador", specs:[
    {specName:"Devastation",label:"Devastación",role:"dps"},
    {specName:"Preservation",label:"Preservación",role:"healer"},
    {specName:"Augmentation",label:"Aumentación",role:"dps"},
  ]},
];

// -------------------- Slots
const SLOT_MAP = new Map(Object.entries({
  head:"head", neck:"neck", shoulder:"shoulder", back:"back", chest:"chest",
  wrist:"wrist", hands:"hands", waist:"waist", legs:"legs", feet:"feet",
  finger1:"ring1", finger2:"ring2", trinket1:"trinket1", trinket2:"trinket2",
  mainhand:"weaponMain", offhand:"weaponOff", twohand:"twoHand",
}));
const SLOT_BY_ID = {
  1:"head",2:"neck",3:"shoulder",15:"back",5:"chest",9:"wrist",10:"hands",
  6:"waist",7:"legs",8:"feet",11:"ring1",12:"ring2",13:"trinket1",14:"trinket2",
  16:"weaponMain",17:"weaponOff",21:"twoHand",
};
const DESIRED_SLOTS = [
  "head","neck","shoulder","back","chest","wrist","hands","waist","legs","feet",
  "ring1","ring2","trinket1","trinket2","weaponMain","weaponOff","twoHand",
];
const normalizeSlot = (slot)=>{
  const t = typeof slot;
  if (t === "string") return SLOT_MAP.get(slot.toLowerCase()) || null;
  if (t === "number") return SLOT_BY_ID[slot] || null;
  return null;
};

// -------------------- Blizzard (token + journal + origen)
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
          srcCache.set(itemId,src); return src;
        }
      }
    }catch{}
  }
  // ¿Crafteo?
  try{
    const it = await (await fetch(
      `https://${REGION}.api.blizzard.com/data/wow/item/${itemId}?namespace=static-${REGION}&locale=${LOCALE}&access_token=${tok}`
    )).json();
    if (it?.preview_item && (it.preview_item.is_crafted || it.preview_item.crafted_quality || it.preview_item.crafting_reagent)){
      const src = {type:"crafted"}; srcCache.set(itemId,src); return src;
    }
  }catch{}
  const fallback = {type:"other"}; srcCache.set(itemId,fallback); return fallback;
}

// Rescate: del Diario de la Raid (elige mayor ilvl por slot entre todos los bosses)
async function journalFallback(zoneEncounters, tok){
  // Recorre todos los encounters y junta items, elige mayor ilvl por slot (aprox)
  const bestBySlot = new Map();
  for (const e of zoneEncounters){
    try{
      const det = await (await fetch(
        `https://${REGION}.api.blizzard.com/data/wow/journal-encounter/${e.id}?namespace=static-${REGION}&locale=${LOCALE}&access_token=${tok}`
      )).json();
      for (const ji of (det.items||[])){
        const itemId = ji?.item?.id; if (!itemId) continue;
        const slot = normalizeSlot(ji?.inventory_type?.type?.toLowerCase?.() || "");
        if (!slot) continue;
        // Tomar item level del "preview_item" si existe
        const full = await (await fetch(
          `https://${REGION}.api.blizzard.com/data/wow/item/${itemId}?namespace=static-${REGION}&locale=${LOCALE}&access_token=${tok}`
        )).json().catch(()=>null);
        const ilvl = full?.preview_item?.item_level?.value || 0;
        const prev = bestBySlot.get(slot);
        if (!prev || ilvl > prev.ilvl) bestBySlot.set(slot, { id:itemId, ilvl });
      }
    }catch{}
    await sleep(80);
  }
  const out = [];
  for (const s of DESIRED_SLOTS){
    const b = bestBySlot.get(s);
    if (b) out.push({ slot:s, id:b.id, source:{type:"raid"} });
  }
  return out;
}

// -------------------- WCL v2 (OAuth + GraphQL)
async function getWclV2Token(){
  if (!WCL_CLIENT_ID || !WCL_CLIENT_SECRET) return null;
  const r = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method:"POST",
    headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:"client_credentials",
      client_id: WCL_CLIENT_ID,
      client_secret: WCL_CLIENT_SECRET
    })
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.access_token || null;
}
async function gqlWcl(query, variables, token){
  const r = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+token },
    body: JSON.stringify({ query, variables })
  });
  if (!r.ok) throw new Error("WCL v2 "+r.status);
  const j = await r.json();
  if (j.errors) throw new Error("WCL v2 errors "+JSON.stringify(j.errors));
  return j.data;
}
const Q_ZONE = `
query($zoneId:Int!){
  worldData { zone(id:$zoneId){ encounters{ id name } } }
}`;
const Q_FIGHT = `
query($encId:Int!, $className:String!, $specName:String!, $metric:RankingMetric!, $diff:Int!, $page:Int!, $partition:Int!){
  worldData{
    encounter(id:$encId){
      fightRankings(
        className:$className, specName:$specName,
        difficulty:$diff, metric:$metric, page:$page,
        partition:$partition, includeCombatantInfo:true
      ){
        hasMorePages
        rankings{
          name
          class
          spec
          // Cuando includeCombatantInfo:true, 'gear' suele aparecer en cada ranking:
          gear { id slot }  // algunos esquemas lo anidan en combatantInfo.gear; manejamos ambos abajo
          combatantInfo { gear { id slot } }
        }
      }
    }
  }
}`;

// -------------------- WCL v1 (fallback)
async function v1(path, params={}){
  if (!WCL_V1_KEY) throw new Error("Sin WCL_V1_KEY");
  const url = new URL(`https://www.warcraftlogs.com/v1/${path}`);
  Object.entries(params).forEach(([k,v])=> url.searchParams.set(k,String(v)));
  url.searchParams.set("api_key", WCL_V1_KEY);
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(path+" -> "+r.status);
  return r.json();
}
async function v1Zones(){ return v1("zones"); }
async function v1Encounter(encId, zoneId, className, specName, metric, difficulty, page){
  return v1(`rankings/encounter/${encId}`, {
    zone: Number(zoneId),
    class: className,    // v1 también soporta nombres modernos
    spec:  specName,
    difficulty,
    metric,
    partition: -1,
    includeCombatantInfo: true,
    page
  });
}

// -------------------- Lógica de construcción por spec
async function buildForSpec({ blizzTok, wclV2Tok, zoneId, className, specName, role }){
  const metric = metricFor(role);
  // 1) Conseguir encounters del zone (prefiero v2; si falla, v1)
  let encounters = [];
  try{
    if (wclV2Tok){
      const d = await gqlWcl(Q_ZONE, { zoneId: Number(zoneId) }, wclV2Tok);
      encounters = d?.worldData?.zone?.encounters || [];
    }
  }catch{}
  if (!encounters.length){
    try{
      const z = await v1Zones();
      const zone = z.find(z=> Number(z.id) === Number(zoneId));
      encounters = (zone?.encounters||[]).map(e=>({id:e.id, name:e.name}));
    }catch{}
  }
  if (!encounters.length) throw new Error("Sin encounters del zone");

  // 2) Intento con WCL v2: fightRankings + includeCombatantInfo
  for (const diff of [4,5]){ // Heroic → Mythic (más datos al inicio)
    const freq = new Map();
    if (wclV2Tok){
      for (const enc of encounters){
        for (let page=1; page<=MAX_PAGES; page++){
          try{
            const d = await gqlWcl(Q_FIGHT, {
              encId: enc.id, className, specName, metric, diff, page, partition: -1
            }, wclV2Tok);
            const fr = d?.worldData?.encounter?.fightRankings;
            const rows = fr?.rankings || [];
            if (page===1) console.log(`[V2] ${className}/${specName} boss ${enc.id} diff ${diff} page1=${rows.length}`);
            if (!rows.length) break;
            for (const r of rows){
              const gearArr = (r?.gear && Array.isArray(r.gear) ? r.gear
                              : r?.combatantInfo?.gear && Array.isArray(r.combatantInfo.gear) ? r.combatantInfo.gear
                              : []);
              for (const g of gearArr){
                const slot = normalizeSlot(g?.slot);
                const id = Number(g?.id);
                if (!slot || !id) continue;
                const key = `${slot}:${id}`;
                freq.set(key, (freq.get(key)||0) + 1);
              }
            }
            await sleep(PAUSE_MS);
            if (!fr?.hasMorePages && page>=1) break;
          }catch(e){
            break; // pasa al siguiente boss
          }
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

    // 3) Fallback v1
    if (WCL_V1_KEY){
      const freq2 = new Map();
      for (const enc of encounters){
        for (let page=1; page<=MAX_PAGES; page++){
          try{
            const ranks = await v1Encounter(enc.id, zoneId, className, specName, metric, diff, page);
            if (!Array.isArray(ranks) || !ranks.length) break;
            if (page===1) console.log(`[V1] ${className}/${specName} boss ${enc.id} diff ${diff} page1=${ranks.length}`);
            for (const r of ranks){
              for (const g of (r.gear||[])){
                const slot = normalizeSlot(g.slot);
                const id = Number(g.id);
                if (!slot || !id) continue;
                const key = `${slot}:${id}`;
                freq2.set(key, (freq2.get(key)||0) + 1);
              }
            }
            await sleep(PAUSE_MS);
          }catch(e){
            break;
          }
        }
      }
      const out2 = [];
      for (const s of DESIRED_SLOTS){
        const best = [...freq2.entries()].filter(([k])=>k.startsWith(s+":")).sort((a,b)=>b[1]-a[1])[0];
        if (!best) continue;
        const itemId = Number(best[0].split(":")[1]);
        const source = await sourceFor(itemId, blizzTok);
        out2.push({ slot:s, id:itemId, source });
      }
      if (out2.length) return out2;
    }
  }

  // 4) Rescate: Diario (para no dejar vacía la UI)
  console.log(`[FALLBACK] Diario para ${className}/${specName}`);
  return await journalFallback(encounters, blizzTok);
}

// -------------------- main
async function main(){
  if (!BLIZZARD_CLIENT_ID || !BLIZZARD_CLIENT_SECRET) {
    console.error("Faltan BLIZZARD_* (Client ID/Secret)");
    process.exit(1);
  }
  const blizzTok = await getBnetToken();
  const wclV2Tok = await getWclV2Token(); // puede ser null; igual seguimos

  const data = {};
  const labels = {};
  for (const cl of CLASSES){
    data[cl.className] = {};
    labels[cl.className] = { label: cl.label, specs:{} };
    for (const sp of cl.specs){
      labels[cl.className].specs[sp.specName] = sp.label;
      try{
        const items = await buildForSpec({
          blizzTok, wclV2Tok, zoneId: Number(RAID_ZONE_ID),
          className: cl.className, specName: sp.specName, role: sp.role
        });
        console.log(`OK ${cl.className}/${sp.specName}: ${items.length} slots`);
        data[cl.className][sp.specName] = items;
      }catch(e){
        console.error(`ERR ${cl.className}/${sp.specName}:`, e.message);
        data[cl.className][sp.specName] = [];
      }
    }
  }

  const out = { meta:{ season:SEASON_LABEL, updated:new Date().toISOString() }, labels, data };
  fs.writeFileSync("bis-feed.js", "window.BIS_FEED = " + JSON.stringify(out, null, 2) + ";\n");
  console.log("bis-feed.js listo.");
}

main().catch(e=>{ console.error(e); process.exit(1); });
