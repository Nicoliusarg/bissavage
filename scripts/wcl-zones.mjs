// scripts/wcl-zones.mjs
const UA = "bissavage/1.0 (GitHub Actions; https://github.com/)";
const Q_ZONES = `query{ worldData { zones { id name encounters { id name } } } }`;

async function getToken(){
  const cid = process.env.WCL_CLIENT_ID;
  const sec = process.env.WCL_CLIENT_SECRET;
  const body = new URLSearchParams({grant_type:"client_credentials", client_id:cid, client_secret:sec});
  const r = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":UA},
    body
  });
  const t = await r.text();
  const j = JSON.parse(t);
  if (!j.access_token) throw new Error("No WCL token");
  return j.access_token;
}

async function gql(query, vars, token){
  const r = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${token}`,
      "User-Agent":UA
    },
    body: JSON.stringify({ query, variables: vars })
  });
  const txt = await r.text();
  return JSON.parse(txt).data;
}

const token = await getToken();
const data  = await gql(Q_ZONES, {}, token);

const zones = (data?.worldData?.zones || [])
  .filter(z => (z.encounters || []).length > 0)
  .sort((a,b) => b.id - a.id);

console.log("=== ZONAS CON BOSSES (zoneId — nombre — #encounters) ===");
for (const z of zones) {
  console.log(`${z.id} — ${z.name} — ${z.encounters.length}`);
}
console.log("\nTIP: Usá el id que corresponda en WCL_RAID_ZONE_ID dentro del workflow.");
