// node server.js — zero dependencies. Serves the page, daily airport sets, and score stats.
const http = require("http"), fs = require("fs");
const FILE = process.env.DATA_FILE || "data.json", MODES = ["easy", "medium", "hard"], PER = 5;
try { for (const l of fs.readFileSync(".env", "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) process.env[m[1]] ??= m[2]; } } catch {}
const AIR = JSON.parse(fs.readFileSync("airports.json"));
const ALL = new Map(Object.values(AIR).flat().map(a => [a[0], a]));
// States with at least PER airports can be played as practice games.
const STATES = Object.entries([...ALL.values()].reduce((c, a) => (c[a[2]] = (c[a[2]] || 0) + 1, c), {})).filter(([, n]) => n >= PER).map(([st]) => st).sort();
// The City and state game: any airport in the same city and state is a right answer. altsOf(a) = the other airports there, as [code, lat, lon, name].
const cityKey = a => a[1] + "|" + a[2], ALTS = new Map();
for (const a of ALL.values()) { if (!ALTS.has(cityKey(a))) ALTS.set(cityKey(a), []); ALTS.get(cityKey(a)).push(a); }
const altsOf = a => ALTS.get(cityKey(a)).filter(x => x[0] !== a[0]).map(x => [x[0], x[3], x[4], x[6]]);
const ORDER = { easy: ["easy", "medium", "hard"], medium: ["medium", "hard", "easy"], hard: ["hard", "medium", "easy"] };
let db = { sets: {}, used: {}, scores: {}, right: {} }; try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE)) }; } catch {}
// db.sets["day:mode"] = 5 airports; db.used[mode] = icaos already served (no repeats until the pool runs out); db.scores["day:mode"] = {playerId: total}
const day = () => Math.floor(Date.now() / 864e5), save = () => fs.writeFileSync(FILE, JSON.stringify(db));

function ensure(d) {
  db.first ??= d; // the archive starts the day this database was first started
  for (const m of MODES) {
    if (db.sets[d + ":" + m]) continue;
    let pool = AIR[m].filter(a => !(db.used[m] || []).includes(a[0]));
    if (pool.length < PER) { db.used[m] = []; pool = AIR[m]; } // pool exhausted: start over
    const pick = [];
    while (pick.length < PER) pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    db.sets[d + ":" + m] = pick;
    (db.used[m] ||= []).push(...pick.map(a => a[0]));
  }
  save();
}
// Archive: players can open any day from db.first (the day this database was started) up to today. A day nobody has opened yet gets a stable
// set from a seeded shuffle, stored so it never changes; today's sets come from ensure() above.
const validDay = d => Number.isInteger(d) && d <= day() && d >= db.first;
function setFor(d, m) {
  const k = d + ":" + m;
  if (!db.sets[k]) {
    let a = ((d * 2654435761) + MODES.indexOf(m) * 40503) >>> 0;
    const rand = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pool = AIR[m].slice(), pick = [];
    while (pick.length < PER) pick.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    db.sets[k] = pick; save();
  }
  return db.sets[k].map(a => ALL.get(a[0]) || a);
}
// Daily loop: generate tomorrow's sets at each UTC midnight. ensure() on startup + per request also covers downtime.
(function tick() { ensure(day()); setTimeout(tick, (day() + 1) * 864e5 - Date.now() + 1000); })();

// dist = how many players got each total; avg / avgRight = mean points / mean rounds solved
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const counts = k => { const dist = {}, s = Object.values(db.scores[k] || {}); for (const t of s) dist[t] = (dist[t] || 0) + 1; return { dist, n: s.length, avg: mean(s), avgRight: mean(Object.values(db.right[k] || {})) }; };
// Background chart: one FAA airport diagram from ./charts (see build-charts.py), picked by day, and never one of today's airports.
function chartOfTheDay() {
  const files = fs.existsSync("charts") ? fs.readdirSync("charts").filter(f => f.endsWith(".jpg")).sort() : [];
  const todays = new Set(MODES.flatMap(m => (db.sets[day() + ":" + m] || []).map(a => a[0])));
  for (let i = 0; i < files.length; i++) { const f = files[(((day() * 2654435761) >>> 0) + i) % files.length]; if (!todays.has(f.slice(0, -4))) return f; }
  return null;
}
// ZIP code -> coordinates, from the free zippopotam.us lookup (no key); answers are kept in memory since a ZIP never moves.
const dist = (a, b, c, d) => { const r = Math.PI / 180, h = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 3959 * 2 * Math.asin(Math.sqrt(h)); };
const zips = new Map();
async function zipPoint(zip) {
  if (zips.has(zip)) return zips.get(zip);
  const r = await fetch("https://api.zippopotam.us/us/" + zip, { signal: AbortSignal.timeout(5000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("lookup failed");
  const pl = (await r.json()).places[0], p = { lat: +pl.latitude, lon: +pl.longitude };
  zips.set(zip, p); return p;
}
// Static files: the page, its stylesheet, the game audio module, and the uisfx player (a self-contained ES module).
const STATIC = { "/style.css": "style.css", "/sfx.js": "sfx.mjs", "/vendor/uisfx.js": "node_modules/uisfx/dist/index.js" };
// Cache busting: the page asks for /style.css?v=<hash of the files>, so after an update every visitor (and Cloudflare) sees a new address and fetches the new file.
const VERSION = require("crypto").createHash("md5").update(["style.css", "sfx.mjs", "node_modules/uisfx/dist/index.js"].map(f => fs.readFileSync(f)).join("")).digest("hex").slice(0, 10);
const page = () => fs.readFileSync("index.html", "utf8").replace(/(\/style\.css|\/sfx\.js|\/vendor\/uisfx\.js)(?=["'])/g, "$1?v=" + VERSION);
const TYPES = { html: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", jpg: "image/jpeg" };
// The page, stylesheet and scripts are sent with no-cache so browsers and Cloudflare re-check them, so an update shows up right away instead of after a stale copy expires.
const serve = (res, f, cache = "no-cache") => (res.writeHead(200, { "content-type": TYPES[f.split(".").pop()] || "application/octet-stream", "cache-control": cache }), res.end(fs.readFileSync(f)));
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"), mode = u.searchParams.get("mode"), json = (o, s = 200) => (res.writeHead(s, { "content-type": "application/json", "cache-control": "no-store" }), res.end(JSON.stringify(o)));
  if (req.method === "GET" && u.pathname === "/") return (res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache" }), res.end(page()));
  if (req.method === "GET" && STATIC[u.pathname]) return serve(res, STATIC[u.pathname]);
  if (req.method === "GET" && u.pathname === "/chart.jpg") { // today's faint background chart
    const f = chartOfTheDay();
    return f ? (res.setHeader("cache-control", "max-age=600"), serve(res, "charts/" + f)) : json({ error: "no charts" }, 404);
  }
  if (req.method === "GET" && u.pathname === "/api/sounds") return json(fs.existsSync("sounds") ? fs.readdirSync("sounds").filter(f => /\.(mp3|wav|ogg)$/.test(f)) : []); // which of your sound files exist (so the page never probes for missing ones)
  if (req.method === "GET" && /^\/sounds\/[\w.-]+\.(mp3|wav|ogg)$/.test(u.pathname)) // sound effects you drop in ./sounds
    return fs.existsSync("." + u.pathname) ? serve(res, "." + u.pathname, "public, max-age=3600") : json({ error: "not found" }, 404);
  if (req.method === "GET" && u.pathname === "/api/config") return json({ key: process.env.GOOGLE_MAPS_KEY || "" });
  if (req.method === "GET" && u.pathname === "/api/lookup") { // coords of any known airport, for hot/cold distance
    const a = ALL.get((u.searchParams.get("code") || "").toUpperCase()); return json(a ? { lat: a[3], lon: a[4] } : {});
  }
  if (req.method === "GET" && u.pathname === "/api/decoys") { // last-guess multiple choice: 3 other airports that start with the same letter as the answer (after the K)
    const c = (u.searchParams.get("code") || "").toUpperCase(), tier = Object.keys(AIR).find(t => AIR[t].some(a => a[0] === c));
    if (!tier) return json({ error: "bad request" }, 400);
    // Every option starts with the same letter after the K (the "Starts with" clue): own tier first, then any tier, then anything, so there are always four options.
    const skip = new Set(String(u.searchParams.get("skip") || "").toUpperCase().split(",")); // other right answers (same city) are never decoys
    const same = l => l.filter(a => a[0] !== c && !skip.has(a[0]) && a[0][1] === c[1]).map(a => a[0]), out = [];
    for (const pool of [same(AIR[tier]), same([...ALL.values()]), [...ALL.keys()].filter(k => k !== c && !skip.has(k))]) while (out.length < 3 && pool.length) { const x = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]; if (!out.includes(x)) out.push(x); }
    return json(out);
  }
  if (req.method === "GET" && u.pathname === "/api/near") { // "Airports near me": up to PER random airports within N miles of a US ZIP code (any difficulty)
    const zip = u.searchParams.get("zip") || "", miles = +u.searchParams.get("miles");
    if (!/^\d{5}$/.test(zip) || ![25, 50, 100, 250, 500].includes(miles)) return json({ error: "Enter a 5-digit ZIP code." }, 400);
    return zipPoint(zip).then(p => {
      if (!p) return json({ error: "Couldn't find that ZIP code." }, 404);
      const near = [...ALL.values()].filter(a => dist(p.lat, p.lon, a[3], a[4]) <= miles), pick = [];
      while (pick.length < PER && near.length) pick.push(near.splice(Math.floor(Math.random() * near.length), 1)[0]);
      json(pick.length ? { day: day(), airports: pick } : { error: `No airports within ${miles} miles of ${zip}. Try a bigger distance.` });
    }).catch(() => json({ error: "Couldn't look that ZIP up right now. Try again." }, 502));
  }
  if (req.method === "GET" && u.pathname === "/api/states") return json(STATES);
  if (req.method === "GET" && u.pathname === "/api/archive") return json({ first: db.first }); // the earliest day players can go back to
  if (req.method === "GET" && u.pathname === "/api/state") { // practice game: 5 random airports in a state, from the chosen difficulty first, topped up from the others
    const st = u.searchParams.get("state");
    if (!MODES.includes(mode) || (st !== "ALL" && !STATES.includes(st))) return json({ error: "bad request" }, 400); // "ALL" = any state
    const pick = [], seen = new Set(); // never two airports from the same city in one game
    for (const t of ORDER[mode]) { const pool = AIR[t].filter(a => st === "ALL" || a[2] === st); while (pick.length < PER && pool.length) { const a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]; if (!seen.has(cityKey(a))) { seen.add(cityKey(a)); pick.push(a); } } }
    return json({ day: day(), airports: pick.map(a => [...a, altsOf(a)]) });
  }
  if (req.method === "GET" && u.pathname === "/api/today") {
    if (!MODES.includes(mode)) return json({ error: "bad mode" }, 400);
    const d = u.searchParams.has("day") ? +u.searchParams.get("day") : day(); // ?day=N (a UTC day number) opens an earlier day from the archive
    if (!validDay(d)) return json({ error: "day out of range" }, 400);
    ensure(day()); return json({ day: d, airports: setFor(d, mode) });
  }
  if (req.method === "POST" && u.pathname === "/api/reset") { // dev only: loopback clients can wipe all score stats
    if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress)) return json({ error: "forbidden" }, 403);
    db.scores = {}; db.right = {}; save(); return json({ ok: true });
  }
  if (req.method === "POST" && u.pathname === "/api/score") {
    let b = ""; req.on("data", c => (b += c, b.length > 1e3 && req.destroy()));
    return req.on("end", () => {
      let p; try { p = JSON.parse(b); } catch { return json({ error: "bad json" }, 400); }
      const ok = Number.isInteger(p.score) && p.score >= 0 && p.score <= 20 && typeof p.id === "string" && p.id.length <= 64 && /^(easy|medium|hard)(-city)?$/.test(p.mode) && validDay(p.day) && (p.right === undefined || (Number.isInteger(p.right) && p.right >= 0 && p.right <= PER));
      if (!ok) return json({ error: "invalid" }, 400);
      const k = p.day + ":" + p.mode, d = (db.scores[k] ||= {});
      if (!(p.id in d)) { d[p.id] = p.score; if (p.right !== undefined) (db.right[k] ||= {})[p.id] = p.right; save(); } // first submission per player per day+mode wins
      json(counts(k));
    });
  }
  json({ error: "not found" }, 404);
}).listen(process.env.PORT || 3000, () => console.log("http://localhost:" + (process.env.PORT || 3000)));
// ponytail: JSON file + sync write, one process. Swap for SQLite/Redis if traffic outgrows it. Player id is client-generated, so not cheat-proof; answers are sent to the client.
