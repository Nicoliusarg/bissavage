// scripts/update-bis.js
// Genera bis-feed.js con window.BIS_FEED = {...} usando Warcraft Logs (popularidad)
// y mapea origen (Raid / M+ / Crafteo) con Blizzard Journal.
// Requiere: node 18+ y node-fetch@3

import fs from 'fs';
import fetch from 'node-fetch';

const {
  WCL_CLIENT_ID,
  WCL_CLIENT_SECRET,
  BLIZZARD_CLIENT_ID,
  BLIZZARD_CLIENT_SECRET,
  REGION = 'us',
  LOCALE = 'es_MX',
  SEASON_LABEL = 'TWW S3',
  RAID_ZONE_ID = '50' // ← actualizar por temporada
} = process.env;

if(!WCL_CLIENT_ID || !WCL_CLIENT_SECRET || !BLIZZARD_CLIENT_ID || !BLIZZARD_CLIENT_SECRET){
  console.error('Faltan secrets de API.');
  process.exit(1);
}

// ————————————————————————————————————————————————
// 🗂️ Specs (todas las clases/especializaciones)
const CLASSES = [
  { className:'Warrior',   label:'Guerrero', specs:[
    { specName:'Arms', label:'Armas' }, { specName:'Fury', label:'Furia' }, { specName:'Protection', label:'Protección' }
  ]},
  { className:'Paladin',   label:'Paladín', specs:[
    { specName:'Holy', label:'Sagrado' }, { specName:'Protection', label:'Protección' }, { specName:'Retribution', label:'Reprensión' }
  ]},
  { className:'Hunter',    label:'Cazador', specs:[
    { specName:'Beast Mastery', label:'Maestro de Bestias' }, { specName:'Marksmanship', label:'Puntería' }, { specName:'Survival', label:'Supervivencia' }
  ]},
  { className:'Rogue',     label:'Pícaro', specs:[
    { specName:'Assassination', label:'Asesinato' }, { specName:'Outlaw', label:'Forajido' }, { specName:'Subtlety', label:'Sutileza' }
  ]},
  { className:'Priest',    label:'Sacerdote', specs:[
    { specName:'Discipline', label:'Disciplina' }, { specName:'Holy', label:'Sagrado' }, { specName:'Shadow', label:'Sombra' }
  ]},
  { className:'Death Knight', label:'Caballero de la Muerte', specs:[
    { specName:'Blood', label:'Sangre' }, { specName:'Frost', label:'Escarcha' }, { specName:'Unholy', label:'Profano' }
  ]},
  { className:'Shaman',    label:'Chamán', specs:[
    { specName:'Elemental', label:'Elemental' }, { specName:'Enhancement', label:'Mejora' }, { specName:'Restoration', label:'Restauración' }
  ]},
  { className:'Mage',      label:'Mago', specs:[
    { specName:'Arcane', label:'Arcano' }, { specName:'Fire', label:'Fuego' }, { specName:'Frost', label:'Escarcha' }
  ]},
  { className:'Warlock',   label:'Brujo', specs:[
    { specName:'Affliction', label:'Aflicción' }, { specName:'Demonology', label:'Demonología' }, { specName:'Destruction', label:'Destrucción' }
  ]},
  { className:'Monk',      label:'Monje', specs:[
    { specName:'Brewmaster', label:'Maestro Cervecero' }, { specName:'Mistweaver', label:'Tejedor de Niebla' }, { specName:'Windwalker', label:'Viajero del Viento' }
  ]},
  { className:'Druid',     label:'Druida', specs:[
    { specName:'Balance', label:'Equilibrio' }, { specName:'Feral', label:'Feral' }, { specName:'Guardian', label:'Guardián' }, { specName:'Restoration', label:'Restauración' }
  ]},
  { className:'Demon Hunter', label:'Cazador de Demonios', specs:[
    { specName:'Havoc', label:'Devastación' }, { specName:'Vengeance', label:'Venganza' }
  ]},
  { className:'Evoker',    label:'Evocador', specs:[
    { specName:'Devastation', label:'Devastación' }, { specName:'Preservation', label:'Preservación' }, { specName:'Augmentation', label:'Aumentación' }
  ]}
];

// ————————————————————————————————————————————————
// 🔐 Tokens
async function getTokenWCL(){
  const res = await fetch('https://www.warcraftlogs.com/oauth/token', {
    method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type:'client_credentials', client_id:WCL_CLIENT_ID, client_secret:WCL_CLIENT_SECRET })
  });
  if(!res.ok) throw new Error('WCL token error '+res.status);
  return (await res.json()).access_token;
}
async function getTokenBlizzard(){
  const res = await fetch(`https://oauth.battle.net/token`, {
    method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type:'client_credentials', client_id:BLIZZARD_CLIENT_ID, client_secret:BLIZZARD_CLIENT_SECRET })
  });
  if(!res.ok) throw new Error('BNet token error '+res.status);
  return (await res.json()).access_token;
}

// ————————————————————————————————————————————————
// 🧠 WCL GraphQL helper
async function gqlWCL(query, variables, token){
  const res = await fetch('https://www.warcraftlogs.com/api/v2/client', {
    method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if(json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}
// Top rankings for a zone/spec to collect gear
const QUERY_ZONE_RANKINGS = `
query TopRankings($zone:Int!, $className:String!, $specName:String!, $page:Int){
  worldData {
    zone(id:$zone){
      name
      rankings(className:$className, specName:$specName, difficulty:5, metric:dps, page:$page){
        rankings { gear { id slot } }
      }
    }
  }
}`;

// ————————————————————————————————————————————————
// 📚 Blizzard Journal mapping (item -> origen)
const instanceIndexCache = { loaded:false, list:[] };
const encounterItemsCache = new Map();
const itemSourceCache = new Map();

async function getInstances(blizzToken){
  if(instanceIndexCache.loaded) return instanceIndexCache.list;
  const idx = await (await fetch(`https://${REGION}.api.blizzard.com/data/wow/journal-instance/index?namespace=static-${REGION}&locale=${LOCALE}&access_token=${blizzToken}`)).json();
  instanceIndexCache.loaded = true;
  instanceIndexCache.list = idx.instances || [];
  return instanceIndexCache.list;
}
async function getEncounterItems(encounterHref, blizzToken){
  if(encounterItemsCache.has(encounterHref)) return encounterItemsCache.get(encounterHref);
  const encData = await (await fetch(`${encounterHref}&access_token=${blizzToken}`)).json();
  const ids = (encData.items || []).map(x=> x?.item?.id).filter(Boolean);
  encounterItemsCache.set(encounterHref, { ids, name: encData.name || '' });
  return encounterItemsCache.get(encounterHref);
}
async function mapSourceForItem(itemId, blizzToken){
  if(itemSourceCache.has(itemId)) return itemSourceCache.get(itemId);
  // Buscar en RAIDs primero, luego DUNGEONS
  const instances = await getInstances(blizzToken);
  for(const inst of instances){
    try{
      const instData = await (await fetch(`${inst.key.href}&access_token=${blizzToken}`)).json();
      const instType = instData?.instance_type?.type;
      if(!instData.encounters) continue;
      for(const enc of instData.encounters){
        const detail = await getEncounterItems(enc.key.href, blizzToken);
        if(detail.ids.includes(itemId)){
          const src = (instType==='RAID')
            ? { type:'raid', instance: instData.name, boss: detail.name }
            : (instType==='DUNGEON' ? { type:'mplus', dungeon: instData.name } : { type:'other' });
          itemSourceCache.set(itemId, src);
          return src;
        }
      }
    }catch(e){ /* ignore */ }
  }
  // Heurística crafteo
  try{
    const it = await (await fetch(`https://${REGION}.api.blizzard.com/data/wow/item/${itemId}?namespace=static-${REGION}&locale=${LOCALE}&access_token=${blizzToken}`)).json();
    const crafted = it?.preview_item && (it.preview_item.is_crafted || it.preview_item.crafted_quality || it.preview_item.crafting_reagent);
    if(crafted){ const src = { type:'crafted' }; itemSourceCache.set(itemId, src); return src; }
  }catch(e){}
  const src = { type:'other' }; itemSourceCache.set(itemId, src); return src;
}

// ————————————————————————————————————————————————
// 🧮 Build BiS by popularity
const SLOT_MAP = new Map(Object.entries({
  head:'head', neck:'neck', shoulder:'shoulder', back:'back', chest:'chest', wrist:'wrist', hands:'hands', waist:'waist', legs:'legs', feet:'feet',
  finger1:'ring1', finger2:'ring2', trinket1:'trinket1', trinket2:'trinket2',
  mainhand:'weaponMain', offhand:'weaponOff', twohand:'twoHand'
}));

async function buildForSpec(wclTok, blizzTok, className, specName){
  const freq = new Map();
  for(const page of [1,2,3]){ // ~top 300
    const data = await gqlWCL(QUERY_ZONE_RANKINGS, { zone:Number(RAID_ZONE_ID), className, specName, page }, wclTok);
    const rankings = data?.worldData?.zone?.rankings?.rankings || [];
    for(const r of rankings){
      for(const g of (r.gear || [])){
        const slotRaw = (g.slot || '').toString().toLowerCase();
        const norm = SLOT_MAP.get(slotRaw) || slotRaw; // keep unknowns out
        if(!norm) continue;
        const key = norm+':'+g.id;
        freq.set(key, (freq.get(key)||0)+1);
      }
    }
  }
  // elegir el más frecuente por slot
  const desired = ['head','neck','shoulder','back','chest','wrist','hands','waist','legs','feet','ring1','ring2','trinket1','trinket2','weaponMain','weaponOff','twoHand'];
  const out = [];
  for(const s of desired){
    const best = [...freq.entries()].filter(([k])=>k.startsWith(s+':')).sort((a,b)=> b[1]-a[1])[0];
    if(!best) continue;
    const itemId = Number(best[0].split(':')[1]);
    const source = await mapSourceForItem(itemId, blizzTok);
    out.push({ slot:s, id:itemId, source });
  }
  return out;
}

async function main(){
  const [wclTok, blizzTok] = await Promise.all([getTokenWCL(), getTokenBlizzard()]);
  const data = {};
  const labels = {};
  for(const cl of CLASSES){
    data[cl.className] = {};
    labels[cl.className] = { label: cl.label, specs:{} };
    for(const sp of cl.specs){
      labels[cl.className].specs[sp.specName] = sp.label;
      try{
        const items = await buildForSpec(wclTok, blizzTok, cl.className, sp.specName);
        data[cl.className][sp.specName] = items;
      }catch(e){
        console.error('Error en', cl.className, sp.specName, e.message);
        data[cl.className][sp.specName] = [];
      }
    }
  }
  const out = {
    meta:{ season: SEASON_LABEL, updated: new Date().toISOString() },
    labels, data
  };
  const js = 'window.BIS_FEED = ' + JSON.stringify(out, null, 2) + ';';
  fs.writeFileSync('bis-feed.js', js);
  console.log('bis-feed.js listo.');
}

main().catch(e=>{ console.error(e); process.exit(1); });
