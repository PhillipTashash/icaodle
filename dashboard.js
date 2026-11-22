// node dashboard.js  ->  http://localhost:4000
// A read-only, local-only dashboard for the player feedback the game saves to feedback.jsonl. It reads the file on every refresh, so you can leave it
// running while the game collects answers. It never writes anything, listens on 127.0.0.1 only, and needs no packages.
// Two tabs: Feedback (the answers), and Live servers (open lobbies with their players, IPs and rough locations; kick a player or ban an IP). The live tab
// talks to the game server on this computer (GAME_URL, default http://127.0.0.1:3000), whose /admin routes only answer here.
//   FEEDBACK_FILE (default feedback.jsonl), DATA_FILE (default data.json: today's and past daily sets, used for flag rates), DASH_PORT (default 4000)
const http = require("http"), fs = require("fs"), net = require("net");
const FEEDBACK = process.env.FEEDBACK_FILE || "feedback.jsonl", DATA = process.env.DATA_FILE || "data.json", PORT = +process.env.DASH_PORT || 4000;
const AIR = JSON.parse(fs.readFileSync("airports.json")); // { easy: [...], medium: [...], hard: [...] }; each: [code, city, state, lat, lon, zoom, name, elevation]
const INFO = new Map(Object.entries(AIR).flatMap(([tier, list]) => list.map(a => [a[0], { code: a[0], name: a[6], city: a[1], state: a[2], tier }])));

const GAME = process.env.GAME_URL || "http://127.0.0.1:3000";
const gameCall = (path, body) => fetch(GAME + path, { method: body ? "POST" : "GET", headers: { "x-admin": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(4000) });
// Rough location from the public IP, using the free ipwho.is lookup (this sends the player's IP address to that service; results are kept in memory for an hour). Private and local addresses are never sent.
const geoCache = new Map();
const isPrivate = ip => /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip.replace(/^::ffff:/, "")) || ip === "::1" || /^(fe80|fc|fd)/i.test(ip);
async function geo(ip) {
  if (!net.isIP(ip)) return "Unknown";
  if (isPrivate(ip)) return "Local network";
  const hit = geoCache.get(ip); if (hit && Date.now() - hit.t < 36e5) return hit.v;
  let v = "Unknown";
  try { const j = await (await fetch("https://ipwho.is/" + encodeURIComponent(ip), { signal: AbortSignal.timeout(4000) })).json(); if (j.success) v = [j.city, j.region, j.country].filter(Boolean).join(", ") + (j.connection && j.connection.isp ? " · " + j.connection.isp : ""); } catch {}
  if (geoCache.size > 2000) geoCache.delete(geoCache.keys().next().value); // oldest out
  geoCache.set(ip, { t: Date.now(), v }); return v;
}
async function live() {
  const r = await gameCall("/admin/state"); if (!r.ok) throw new Error("game server said " + r.status);
  const d = await r.json();
  const ips = [...new Set([...d.rooms.flatMap(x => x.players.map(p => p.ip)), ...d.bans.map(b => b.ip)].filter(Boolean))];
  // At most 8 brand-new lookups per refresh (the rest say "Looking up…" and fill in on the next one), so 100 lobbies never means a burst of outside requests.
  const fresh = ips.filter(ip => net.isIP(ip) && !isPrivate(ip) && !geoCache.has(ip)).slice(0, 8), allowed = new Set(fresh);
  const loc = Object.fromEntries(await Promise.all(ips.map(async ip => [ip, !net.isIP(ip) || isPrivate(ip) || geoCache.has(ip) || allowed.has(ip) ? await geo(ip) : "Looking up…"])));
  for (const room of d.rooms) for (const p of room.players) p.geo = loc[p.ip] || "";
  for (const b of d.bans) b.geo = loc[b.ip] || "";
  return d;
}

// The feedback summary is rebuilt only when feedback.jsonl or data.json actually changed (checked by size and modified time), so refreshing is nearly free.
let built = null, builtSig = "";
const sig = () => [FEEDBACK, DATA].map(f => { try { const t = fs.statSync(f); return t.size + ":" + t.mtimeMs; } catch { return "-"; } }).join("|");
function build() { const g = sig(); if (built && g === builtSig) return built; built = rebuild(); builtSig = g; return built; }
function rebuild() {
  let rows = [];
  try { rows = fs.readFileSync(FEEDBACK, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  let sets = {}; try { sets = JSON.parse(fs.readFileSync(DATA, "utf8")).sets || {}; } catch {}
  const by = (key) => { const o = {}; for (const r of rows) { const k = key(r); (o[k] ||= { total: 0, fun: 0, meh: 0, hard: 0 }); o[k].total++; o[k][r.rating]++; } return o; };
  // Per airport: how often it was flagged. For daily games we also know which five airports each answer was about (the day's set), so we can give a rate.
  const air = new Map(), get = (c) => air.get(c) || (air.set(c, { flags: 0, shown: 0 }), air.get(c));
  for (const r of rows) {
    for (const c of r.airports || []) get(c).flags++;
    if (r.kind === "daily") for (const a of sets[r.day + ":" + r.mode] || []) get(a[0]).shown++;
  }
  const airports = [...air].map(([c, v]) => ({ ...(INFO.get(c) || { code: c, name: "", city: "", state: "", tier: "" }), flags: v.flags, shown: v.shown, rate: v.shown ? v.flags / v.shown : null }))
    .filter(a => a.flags).sort((a, b) => b.flags - a.flags || (b.rate ?? 0) - (a.rate ?? 0));
  return { total: rows.length, ratings: by(() => "all").all || { total: 0, fun: 0, meh: 0, hard: 0 }, byMode: by(r => r.mode), byKind: by(r => r.kind), byDay: by(r => r.day), airports, recent: rows.slice(-25).reverse(), file: FEEDBACK };
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ICAOdle feedback</title>
<style>
:root{--bg:#0d1014;--card:#161a22;--line:#2f3745;--text:#e8eaee;--mute:#9aa3b2;--amber:#ffb81c;--ok:#3fb950;--warn:#d29922;--bad:#f85149}
@media (prefers-color-scheme:light){:root{--bg:#f5f6f8;--card:#fff;--line:#d5d9e0;--text:#1c2128;--mute:#5b6573;--amber:#b06f00;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}main{max-width:1000px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;color:var(--amber);text-transform:uppercase;letter-spacing:.08em}p.sub{color:var(--mute);margin:0 0 16px}
button{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 14px;cursor:pointer;font:inherit}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card b{display:block;font-size:26px}.card span{color:var(--mute);font-size:13px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);font-size:14px}th{color:var(--mute);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.06em}tr:last-child td{border-bottom:0}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.code{font:600 14px ui-monospace,Consolas,monospace}.mute{color:var(--mute)}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--line);min-width:120px}.bar i{display:block}.f{background:var(--ok)}.m{background:var(--warn)}.h{background:var(--bad)}
.tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;border:1px solid var(--line)}.t-fun{color:var(--ok)}.t-meh{color:var(--warn)}.t-hard{color:var(--bad)}
.empty{color:var(--mute);padding:14px}
nav{display:flex;gap:6px;margin:0 0 18px;border-bottom:1px solid var(--line)}nav button{border:0;border-radius:8px 8px 0 0;background:none;color:var(--mute);padding:8px 16px}nav button.on{color:var(--text);box-shadow:inset 0 -2px 0 var(--amber)}
input{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font:inherit}
.room{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0 0 14px;overflow:hidden}.room>header{display:flex;gap:12px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line)}
.room>header b{font:700 18px ui-monospace,Consolas,monospace;letter-spacing:.15em;color:var(--amber)}.room table{border:0;border-radius:0}
.ph{padding:1px 10px;border-radius:10px;font-size:12px;border:1px solid var(--line)}.ph-playing{color:var(--ok)}.ph-lobby{color:var(--mute)}.ph-over{color:var(--warn)}
.row-actions{display:flex;gap:6px;justify-content:flex-end}.row-actions button{padding:3px 10px;font-size:13px}button.danger{color:var(--bad);border-color:var(--bad)}
</style>
<main><h1>ICAOdle dashboard</h1>
<nav><button id="nav-fb" class="on">Feedback</button><button id="nav-live">Live servers</button></nav>
<section id="tab-fb"><p class="sub"><span id="src"></span> · <button id="re">Refresh</button> <span id="upd" class="mute"></span></p>
<div class="cards" id="cards"></div>
<h2>Airports that bothered players</h2><div id="airports"></div>
<h2>By difficulty</h2><div id="modes"></div>
<h2>By game type</h2><div id="kinds"></div>
<h2>Latest answers</h2><div id="recent"></div></section>
<section id="tab-live" hidden><p class="sub">Open lobbies on this computer's game server. Updates every 10 seconds while this tab is open. <span id="liveupd" class="mute"></span></p><p><b id="livesum"></b></p>
<div id="rooms"></div>
<h2>Banned IP addresses</h2><div id="bans"></div>
<p class="sub" style="margin-top:12px"><input id="banip" placeholder="IP address to ban" size="22"> <button id="banbtn">Ban IP</button></p></section></main>
<script>
const NAME={easy:"Normal",medium:"Hard",hard:"Extra Hard"},TIER=NAME;
const el=(t,props,...kids)=>{const e=document.createElement(t);Object.assign(e,props||{});for(const k of kids)e.append(k);return e};
const pct=(n,t)=>t?Math.round(100*n/t)+"%":"–";
const bar=r=>{const b=el("div",{className:"bar"});for(const[k,c]of[["f","fun"],["m","meh"],["h","hard"]])if(r[c]){const i=el("i",{className:k});i.style.width=(100*r[c]/r.total)+"%";i.title=c+": "+r[c];b.append(i)}return b};
function table(head,rows,numCols){if(!rows.length)return el("div",{className:"empty"},"Nothing here yet.");
  return el("table",{},el("thead",{},el("tr",{},...head.map((h,i)=>el("th",{className:numCols.includes(i)?"n":""},h)))),el("tbody",{},...rows.map(r=>el("tr",{},...r.map((c,i)=>el("td",{className:numCols.includes(i)?"n":""},c))))))}
function fill(id,node){const d=document.getElementById(id);d.replaceChildren(node)}
async function load(){
  const d=await fetch("/data").then(r=>r.json());
  document.getElementById("src").textContent=d.file;document.getElementById("upd").textContent="updated "+new Date().toLocaleTimeString();
  const t=d.total,r=d.ratings;
  document.getElementById("cards").replaceChildren(...[["Answers",t],["Fun",pct(r.fun,t)],["Meh",pct(r.meh,t)],["Too hard",pct(r.hard,t)]].map(([l,v])=>el("div",{className:"card"},el("b",{},String(v)),el("span",{},l))));
  fill("airports",table(["Airport","Name","Where","Tier","Flagged","Shown","Rate"],d.airports.map(a=>[el("span",{className:"code"},a.code),a.name||"",a.city?a.city+", "+a.state:"",TIER[a.tier]||"",String(a.flags),a.shown?String(a.shown):"–",a.rate==null?"–":Math.round(a.rate*100)+"%"]),[4,5,6]));
  const grp=o=>Object.entries(o).map(([k,v])=>[k,v]);
  fill("modes",table(["Difficulty","Answers","Fun","Meh","Too hard","Mix"],Object.entries(d.byMode).sort().map(([k,v])=>[NAME[k]||k,String(v.total),pct(v.fun,v.total),pct(v.meh,v.total),pct(v.hard,v.total),bar(v)]),[1,2,3,4]));
  fill("kinds",table(["Game","Answers","Fun","Meh","Too hard","Mix"],Object.entries(d.byKind).sort().map(([k,v])=>[k==="daily"?"Daily":k==="friend"?"Friend lobby":k,String(v.total),pct(v.fun,v.total),pct(v.meh,v.total),pct(v.hard,v.total),bar(v)]),[1,2,3,4]));
  fill("recent",table(["When","Game","Difficulty","Rating","Airports flagged"],d.recent.map(x=>[new Date(x.t).toLocaleString(),x.kind==="daily"?"Daily":"Friend",NAME[x.mode]||x.mode,el("span",{className:"tag t-"+x.rating},({fun:"Fun",meh:"Meh",hard:"Too hard"})[x.rating]||x.rating),(x.airports||[]).join(", ")||"–"]),[]));
}
document.getElementById("re").onclick=load;load();setInterval(()=>{if(!document.hidden&&!document.getElementById("tab-fb").hidden)load()},60000); // feedback: once a minute, only while it's on screen
// tabs
let liveTimer=null,showAll=false;const LIVE_MS=10000,CAP=25; // live servers: every 10 s, one request at a time, paused while the tab is hidden, first 25 lobbies unless you ask for all
function tab(which){for(const t of["fb","live"]){document.getElementById("tab-"+t).hidden=t!==which;document.getElementById("nav-"+t).classList.toggle("on",t===which)}
  clearTimeout(liveTimer);if(which==="live")liveLoop()}
async function liveLoop(){if(!document.hidden)await loadLive();liveTimer=setTimeout(()=>{if(!document.getElementById("tab-live").hidden)liveLoop()},LIVE_MS)}
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&!document.getElementById("tab-live").hidden){clearTimeout(liveTimer);liveLoop()}});
document.getElementById("nav-fb").onclick=()=>tab("fb");document.getElementById("nav-live").onclick=()=>tab("live");
// live servers
async function api(path,body){const r=await fetch(path,{method:body?"POST":"GET",headers:{"x-admin":"1","content-type":"application/json"},body:body?JSON.stringify(body):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw j;return j}
const mmss=ms=>Math.floor(ms/6e4)+":"+String(Math.floor(ms/1e3)%60).padStart(2,"0");
const ago=ms=>ms<5000?"just now":ms<6e4?Math.round(ms/1e3)+"s ago":Math.round(ms/6e4)+" min ago";
async function act(path,body,question){if(question&&!confirm(question))return;try{await api(path,body)}catch(e){alert((e&&e.error)||"That didn't work.")}loadLive()}
function phase(r){return r.phase==="playing"?"Playing · "+mmss(r.left)+" left":r.phase==="over"?"Game over":r.cd!=null?"Starting in "+Math.ceil(r.cd/1e3)+"s":"Lobby"}
async function loadLive(){
  let d;try{d=await api("/api/live")}catch(e){fill("rooms",el("div",{className:"empty"},(e&&e.error)||"Can't reach the game server. Is it running (npm start)?"));return}
  document.getElementById("liveupd").textContent="updated "+new Date().toLocaleTimeString();
  const bannedIps=new Set(d.bans.map(b=>b.ip));
  const order={playing:0,lobby:1,over:2},rooms=[...d.rooms].sort((a,b)=>order[a.phase]-order[b.phase]||a.age-b.age),shown=showAll?rooms:rooms.slice(0,CAP);
  const players=rooms.reduce((n,r)=>n+r.players.length,0),playing=rooms.filter(r=>r.phase==="playing").length;
  document.getElementById("livesum").textContent=rooms.length+" lobb"+(rooms.length===1?"y":"ies")+" · "+players+" player"+(players===1?"":"s")+" · "+playing+" playing now";
  document.getElementById("rooms").replaceChildren(...(rooms.length?[...shown.map(r=>el("div",{className:"room"},
    el("header",{},el("b",{},r.code),el("span",{className:"ph ph-"+r.phase},phase(r)),el("span",{className:"mute"},(NAME[r.mode]||r.mode)+" · open "+ago(r.age)+" · "+r.players.length+" player"+(r.players.length===1?"":"s"))),
    table(["Player","IP address","Location","Status","Seen",""],r.players.map(p=>[p.name+(p.wins?" ⭐".repeat(1)+(p.wins>1?"×"+p.wins:""):""),el("span",{className:"code"},p.ip||"unknown"),p.geo||"",
      r.phase==="lobby"?(p.ready?"Ready":"Not ready"):p.done?"Finished · "+p.total+" pts":p.rounds+"/5 rounds · "+p.total+" pts",ago(p.seen),
      el("div",{className:"row-actions"},el("button",{onclick:()=>act("/api/kick",{code:r.code,id:p.id},"Remove "+p.name+" from this lobby?")},"Kick"),
        p.ip&&!bannedIps.has(p.ip)?el("button",{className:"danger",onclick:()=>act("/api/ban",{ip:p.ip,name:p.name},"Ban IP "+p.ip+"? Everyone on that address is removed from lobbies and blocked from the whole game.")},"Ban IP"):el("span",{className:"mute"},p.ip?"banned":""))]),[])
  )),...(rooms.length>shown.length?[el("button",{onclick:()=>{showAll=true;loadLive()}},"Show all "+rooms.length+" lobbies")]:[])]:[el("div",{className:"empty"},"No open lobbies right now.")]));
  fill("bans",table(["IP address","Location","Player","Banned","" ],d.bans.map(b=>[el("span",{className:"code"},b.ip),b.geo||"",b.name||"",new Date(b.t).toLocaleString(),
    el("div",{className:"row-actions"},el("button",{onclick:()=>act("/api/unban",{ip:b.ip},"Unban "+b.ip+"?")},"Unban"))]),[]));
}
document.getElementById("banbtn").onclick=()=>{const ip=document.getElementById("banip").value.trim();if(ip)act("/api/ban",{ip},"Ban IP "+ip+"?").then(()=>document.getElementById("banip").value="")};
</script>`;

http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname, json = (o, st = 200) => (res.writeHead(st, { "content-type": "application/json", "cache-control": "no-store" }), res.end(JSON.stringify(o)));
  // Only this computer's own page may talk to this server: the Host must be localhost (blocks DNS-rebinding tricks) and writes need our header and a same-origin Origin.
  const okHost = h => new RegExp("^(localhost|127\\.0\\.0\\.1)(:" + PORT + ")?$").test(h || "");
  if (!okHost(req.headers.host)) { res.writeHead(403); return res.end("forbidden"); }
  if (path === "/api/live") { try { return json(await live()); } catch (e) { return json({ error: "Can't reach the game server. Is it running (npm start)?" }, 502); } }
  if (req.method === "POST" && ["/api/kick", "/api/ban", "/api/unban"].includes(path)) {
    const origin = req.headers.origin; if (req.headers["x-admin"] !== "1" || (origin && !okHost(origin.replace(/^https?:\/\//, "")))) return json({ error: "forbidden" }, 403);
    let b = ""; req.on("data", c => (b += c, b.length > 1e3 && req.destroy()));
    return req.on("end", async () => { try { const r = await gameCall("/admin/" + path.slice(5), JSON.parse(b)); return json(await r.json(), r.status); } catch { return json({ error: "Can't reach the game server." }, 502); } });
  }
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  if (path === "/") { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); return res.end(PAGE); }
  if (path === "/data") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(JSON.stringify(build())); }
  res.writeHead(404); res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`Feedback dashboard: http://localhost:${PORT}  (reading ${FEEDBACK})`));
