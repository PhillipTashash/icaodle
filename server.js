// node server.js — zero dependencies. Serves the page, daily airport sets, and score stats.
const http = require("http"), fs = require("fs");
const FILE = process.env.DATA_FILE || "data.json", MODES = ["easy", "medium", "hard"], PER = 5;
try { for (const l of fs.readFileSync(".env", "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) process.env[m[1]] ??= m[2]; } } catch {}
const AIR = JSON.parse(fs.readFileSync("airports.json"));
const ALL = new Map(Object.values(AIR).flat().map(a => [a[0], a]));
// States with at least PER airports can be played as practice games.
const STATES = Object.entries([...ALL.values()].reduce((c, a) => (c[a[2]] = (c[a[2]] || 0) + 1, c), {})).filter(([, n]) => n >= PER).map(([st]) => st).sort();
const ORDER = { easy: ["easy", "medium", "hard"], medium: ["medium", "hard", "easy"], hard: ["hard", "medium", "easy"] };
let db = { sets: {}, used: {}, scores: {}, right: {} }; try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE)) }; } catch {}
// db.sets["day:mode"] = 5 airports; db.used[mode] = icaos already served (no repeats until the pool runs out); db.scores["day:mode"] = {playerId: total}
const day = () => Math.floor(Date.now() / 864e5), save = () => fs.writeFileSync(FILE, JSON.stringify(db));

function ensure(d) {
  for (const m of MODES) {
    if (db.sets[d + ":" + m]) continue;
    let pool = AIR[m].filter(a => !(db.used[m] || []).includes(a[0]));
    if (pool.length < PER) { db.used[m] = []; pool = AIR[m]; } // pool exhausted: start over
    const pick = [];
    while (pick.length < PER) pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    db.sets[d + ":" + m] = pick;
    (db.used[m] ||= []).push(...pick.map(a => a[0]));
  }
  for (const k of Object.keys(db.sets)) if (+k.split(":")[0] < d - 2) delete db.sets[k]; // keep the file small
  save();
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
// Static files: the page, its stylesheet, the game audio module, and the uisfx player (a self-contained ES module).
const STATIC = { "/": "index.html", "/style.css": "style.css", "/sfx.js": "sfx.mjs", "/vendor/uisfx.js": "node_modules/uisfx/dist/index.js" };
const TYPES = { html: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", jpg: "image/jpeg" };
const serve = (res, f) => (res.writeHead(200, { "content-type": TYPES[f.split(".").pop()] || "application/octet-stream" }), res.end(fs.readFileSync(f)));
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"), mode = u.searchParams.get("mode"), json = (o, s = 200) => (res.writeHead(s, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
  if (req.method === "GET" && STATIC[u.pathname]) return serve(res, STATIC[u.pathname]);
  if (req.method === "GET" && u.pathname === "/chart.jpg") { // today's faint background chart
    const f = chartOfTheDay();
    return f ? (res.setHeader("cache-control", "max-age=600"), serve(res, "charts/" + f)) : json({ error: "no charts" }, 404);
  }
  if (req.method === "GET" && u.pathname === "/api/sounds") return json(fs.existsSync("sounds") ? fs.readdirSync("sounds").filter(f => /\.(mp3|wav|ogg)$/.test(f)) : []); // which of your sound files exist (so the page never probes for missing ones)
  if (req.method === "GET" && /^\/sounds\/[\w.-]+\.(mp3|wav|ogg)$/.test(u.pathname)) // sound effects you drop in ./sounds
    return fs.existsSync("." + u.pathname) ? serve(res, "." + u.pathname) : json({ error: "not found" }, 404);
  if (req.method === "GET" && u.pathname === "/api/config") return json({ key: process.env.GOOGLE_MAPS_KEY || "" });
  if (req.method === "GET" && u.pathname === "/api/lookup") { // coords of any known airport, for hot/cold distance
    const a = ALL.get((u.searchParams.get("code") || "").toUpperCase()); return json(a ? { lat: a[3], lon: a[4] } : {});
  }
  if (req.method === "GET" && u.pathname === "/api/states") return json(STATES);
  if (req.method === "GET" && u.pathname === "/api/state") { // practice game: 5 random airports in a state, from the chosen difficulty first, topped up from the others
    const st = u.searchParams.get("state");
    if (!MODES.includes(mode) || (st !== "ALL" && !STATES.includes(st))) return json({ error: "bad request" }, 400); // "ALL" = any state
    const pick = [];
    for (const t of ORDER[mode]) { const pool = AIR[t].filter(a => st === "ALL" || a[2] === st); while (pick.length < PER && pool.length) pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]); }
    return json({ day: day(), airports: pick });
  }
  if (req.method === "GET" && u.pathname === "/api/today") {
    if (!MODES.includes(mode)) return json({ error: "bad mode" }, 400);
    ensure(day()); return json({ day: day(), airports: db.sets[day() + ":" + mode].map(a => ALL.get(a[0]) || a) });
  }
  if (req.method === "POST" && u.pathname === "/api/reset") { // dev only: loopback clients can wipe all score stats
    if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress)) return json({ error: "forbidden" }, 403);
    db.scores = {}; db.right = {}; save(); return json({ ok: true });
  }
  if (req.method === "POST" && u.pathname === "/api/score") {
    let b = ""; req.on("data", c => (b += c, b.length > 1e3 && req.destroy()));
    return req.on("end", () => {
      let p; try { p = JSON.parse(b); } catch { return json({ error: "bad json" }, 400); }
      const ok = Number.isInteger(p.score) && p.score >= 0 && p.score <= 20 && typeof p.id === "string" && p.id.length <= 64 && /^(easy|medium|hard)(-city)?$/.test(p.mode) && Math.abs(p.day - day()) <= 1 && (p.right === undefined || (Number.isInteger(p.right) && p.right >= 0 && p.right <= PER));
      if (!ok) return json({ error: "invalid" }, 400);
      const k = p.day + ":" + p.mode, d = (db.scores[k] ||= {});
      if (!(p.id in d)) { d[p.id] = p.score; if (p.right !== undefined) (db.right[k] ||= {})[p.id] = p.right; save(); } // first submission per player per day+mode wins
      json(counts(k));
    });
  }
  json({ error: "not found" }, 404);
}).listen(process.env.PORT || 3000, () => console.log("http://localhost:" + (process.env.PORT || 3000)));
// ponytail: JSON file + sync write, one process. Swap for SQLite/Redis if traffic outgrows it. Player id is client-generated, so not cheat-proof; answers are sent to the client.
