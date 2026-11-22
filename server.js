// node server.js — zero dependencies. Serves the page, daily airport sets, and score stats.
const http = require("http"), fs = require("fs");
const FEEDBACK = process.env.FEEDBACK_FILE || "feedback.jsonl", FILE = process.env.DATA_FILE || "data.json", MODES = ["easy", "medium", "hard"], PER = 5;
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
// A random game: 5 airports in a state ("ALL" = anywhere) from the chosen difficulty first, topped up from the others; never two from one city. Each carries its same-city alternates.
function randomSet(mode, st) {
  const pick = [], seen = new Set();
  for (const t of ORDER[mode]) { const pool = AIR[t].filter(a => st === "ALL" || a[2] === st); while (pick.length < PER && pool.length) { const a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]; if (!seen.has(cityKey(a))) { seen.add(cityKey(a)); pick.push(a); } } }
  return pick.map(a => [...a, altsOf(a)]);
}
// "Play a friend": a 4-letter code shares one random set between two players. In memory only (a restart ends open games); rooms expire after a day.
const rooms = new Map(), MAX_ROOMS = 300;
// Everything a player types or sends is untrusted. Names: no control, invisible or direction-changing characters, no angle brackets, one space between words, 12 characters.
const NAME_BAD = new RegExp("[" + [[0, 31], [127, 159], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]].map(([x, y]) => String.fromCharCode(x) + "-" + String.fromCharCode(y)).join("") + "<>]", "g"); // control, zero-width, line/paragraph separators, direction overrides, BOM, angle brackets
const cleanName = t => [...String(t ?? "").replace(NAME_BAD, "").replace(/\s+/g, " ").trim()].slice(0, 12).join("");
const validId = t => typeof t === "string" && /^[\w-]{1,64}$/.test(t); // player ids are random UUIDs; this also rules out keys like "__proto__"
// A small rate limit per client address (behind a tunnel the real address is in a header): at most N requests a minute per route.
const hits = new Map();
const clientIp = req => String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
function limited(req, route, max) {
  const now = Date.now(), k = route + "|" + clientIp(req); let h = hits.get(k);
  if (!h || now - h.t > 60000) { if (hits.size > 5000) hits.clear(); hits.set(k, h = { t: now, n: 0 }); }
  return ++h.n > max;
}
const roomCode = () => { for (;;) { const c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.random() * 24 | 0]).join(""); if (!rooms.has(c)) return c; } };
const MAXP = 5, CD_MS = 5000, GAME_MS = 5 * 60000;
// Lobby -> playing -> over. Everyone Ready (2 or more) starts a 5-second countdown that any un-ready cancels; then 5 minutes; over when all are done or time is up.
function roomTick(r) {
  const now = Date.now();
  if (r.phase === "lobby") {
    for (const [k, q] of Object.entries(r.players)) if (now - q.seen > 15000) delete r.players[k]; // players who closed the page
    const ps = Object.values(r.players);
    if (ps.length >= 2 && ps.every(q => q.ready)) r.cd ??= now; else r.cd = null;
    if (r.cd && now - r.cd >= CD_MS) { r.phase = "playing"; r.end = r.cd + CD_MS + GAME_MS; }
  }
  if (r.phase === "playing" && (now >= r.end || Object.values(r.players).every(q => q.done))) {
    r.phase = "over"; const ps = Object.values(r.players); for (const q of ps) q.done = true;
    const top = Math.max(...ps.map(q => q.total)); if (ps.length > 1) for (const q of ps) if (q.total === top) q.wins = (q.wins || 0) + 1; // a win (a star) for the top score; ties share it
  }
}
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
const APP_VERSION = JSON.parse(fs.readFileSync("package.json", "utf8")).version; // shown in the page footer: bump "version" in package.json when you release
const page = () => fs.readFileSync("index.html", "utf8").replace("__VERSION__", APP_VERSION).replace(/(\/style\.css|\/sfx\.js|\/vendor\/uisfx\.js)(?=["'])/g, "$1?v=" + VERSION);
const TYPES = { html: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", jpg: "image/jpeg" };
// The page, stylesheet and scripts are sent with no-cache so browsers and Cloudflare re-check them, so an update shows up right away instead of after a stale copy expires.
const serve = (res, f, cache = "no-cache") => (res.writeHead(200, { "content-type": TYPES[f.split(".").pop()] || "application/octet-stream", "cache-control": cache }), res.end(fs.readFileSync(f)));
// IP bans: bans.json (override with BANS_FILE). A banned address gets "Access denied" for every page and API; the admin routes below are the only way to change the list.
const BANS_FILE = process.env.BANS_FILE || "bans.json", bans = new Map();
try { for (const b of JSON.parse(fs.readFileSync(BANS_FILE, "utf8"))) bans.set(b.ip, b); } catch {}
const saveBans = () => fs.writeFileSync(BANS_FILE, JSON.stringify([...bans.values()], null, 2));
// Admin routes: loopback only (this computer), never through a tunnel or proxy, and only with an x-admin header, which a web page on another site cannot add without a permission check the server never grants.
const adminOk = req => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress) && !req.headers["cf-connecting-ip"] && !req.headers["x-forwarded-for"] && req.headers["x-admin"] === "1";
function admin(req, res, u) {
  const out = (o, st = 200) => (res.writeHead(st, { "content-type": "application/json", "cache-control": "no-store" }), res.end(JSON.stringify(o)));
  if (!adminOk(req)) return out({ error: "forbidden" }, 403);
  if (req.method === "GET" && u.pathname === "/admin/state") {
    const now = Date.now();
    return out({ now, bans: [...bans.values()], rooms: [...rooms].filter(([, r]) => { roomTick(r); return Object.keys(r.players).length; }).map(([code, r]) => { return {
      code, mode: r.mode, phase: r.phase, age: now - r.at, cd: r.cd && r.phase === "lobby" ? Math.max(0, r.cd + CD_MS - now) : null, left: r.phase === "playing" ? Math.max(0, r.end - now) : null,
      players: Object.entries(r.players).map(([id, q]) => ({ id, name: q.name, ip: q.ip || "", ready: q.ready, rounds: q.rounds, total: q.total, done: q.done, wins: q.wins || 0, seen: now - q.seen })) }; }) });
  }
  if (req.method !== "POST") return out({ error: "not found" }, 404);
  let b = ""; req.on("data", c => (b += c, b.length > 1e3 && req.destroy()));
  return req.on("end", () => {
    let p; try { p = JSON.parse(b); } catch { return out({ error: "bad json" }, 400); }
    const kick = (r, id) => { (r.kicked ||= new Set()).add(id); delete r.players[id]; };
    if (u.pathname === "/admin/kick") {
      const r = rooms.get(String(p.code)); if (!r || !(p.id in r.players)) return out({ error: "no such player" }, 404);
      kick(r, p.id); if (!Object.keys(r.players).length) rooms.delete(p.code); else roomTick(r);
      return out({ ok: true });
    }
    if (u.pathname === "/admin/ban") {
      if (!require("net").isIP(p.ip)) return out({ error: "bad ip" }, 400);
      bans.set(p.ip, { ip: p.ip, name: cleanName(p.name), t: new Date().toISOString() }); saveBans();
      for (const [code, r] of rooms) { for (const [id, q] of Object.entries(r.players)) if (q.ip === p.ip) kick(r, id); if (!Object.keys(r.players).length) rooms.delete(code); } // everyone on that address leaves their lobby
      return out({ ok: true });
    }
    if (u.pathname === "/admin/unban") { bans.delete(p.ip); saveBans(); return out({ ok: true }); }
    out({ error: "not found" }, 404);
  });
}
// Every 30 seconds: let lobbies tidy themselves (players who left are dropped) and delete lobbies nobody is in.
setInterval(() => { for (const [k, r] of rooms) { roomTick(r); if (!Object.keys(r.players).length) rooms.delete(k); } }, 30000).unref();
http.createServer((req, res) => {
  res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "same-origin");
  res.setHeader("content-security-policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'"); // no framing, no <base> tricks, no plugins
  if (bans.has(clientIp(req)) && !req.url.startsWith("/admin/")) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("Access denied."); }
  const u = new URL(req.url, "http://x"), mode = u.searchParams.get("mode"), json = (o, s = 200) => (res.writeHead(s, { "content-type": "application/json", "cache-control": "no-store" }), res.end(JSON.stringify(o)));
  if (u.pathname.startsWith("/admin/")) return admin(req, res, u);
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
    return json({ day: day(), airports: randomSet(mode, st) });
  }
  if (req.method === "GET" && u.pathname === "/api/today") {
    if (!MODES.includes(mode)) return json({ error: "bad mode" }, 400);
    const d = u.searchParams.has("day") ? +u.searchParams.get("day") : day(); // ?day=N (a UTC day number) opens an earlier day from the archive
    if (!validDay(d)) return json({ error: "day out of range" }, 400);
    ensure(day()); return json({ day: d, airports: setFor(d, mode) });
  }
  if (req.method === "POST" && u.pathname === "/api/room") { // action: create {name, mode} | join {code, name} | sync {code, rounds, total, right, done} | ready {code, value} | reset {code}
    if (limited(req, "room", 600)) return json({ error: "Slow down a little." }, 429);
    let b = ""; req.on("data", c => (b += c, b.length > 1e3 && req.destroy()));
    return req.on("end", () => {
      let p; try { p = JSON.parse(b); } catch { return json({ error: "bad json" }, 400); }
      if (!p || typeof p !== "object" || !validId(p.id)) return json({ error: "bad request" }, 400);
      const now = Date.now(), name = cleanName(p.name); let r, code = String(p.code || "").toUpperCase();
      if (p.action === "create") {
        if (!MODES.includes(p.mode) || !name) return json({ error: "Enter your name." }, 400);
        for (const [k, v] of rooms) if (now - v.at > 864e5) rooms.delete(k);
        if (rooms.size >= MAX_ROOMS) return json({ error: "Too many games right now. Try again in a bit." }, 503);
        code = roomCode(); rooms.set(code, r = { mode: p.mode, airports: randomSet(p.mode, "ALL"), players: Object.create(null), phase: "lobby", cd: null, end: 0, at: now });
      } else if (!(r = rooms.get(code))) return json({ error: "No game with that code." }, 404);
      if (p.action === "leave") { // leaving takes you off the list at once (an empty game is deleted)
        delete r.players[p.id]; if (!Object.keys(r.players).length) rooms.delete(code); else roomTick(r);
        return json({ left: true });
      }
      if (r.kicked && r.kicked.has(p.id)) return json({ error: "You were removed from this game." }, 403);
      let me = r.players[p.id];
      if (!me) { // new players: create / join only, and only before the game starts
        if (p.action !== "create" && p.action !== "join") return json({ error: "You're no longer in that game." }, 410);
        if (!name) return json({ error: "Enter your name." }, 400);
        if (r.phase === "playing") return json({ error: "That game has already started." }, 409);
        if (Object.keys(r.players).length >= MAXP) return json({ error: "That game is full." }, 409);
        me = r.players[p.id] = { name, ready: false, rounds: 0, total: 0, right: 0, done: false };
      }
      me.seen = now; me.ip = clientIp(req); if (name) me.name = name;
      const num = (v, max) => Number.isInteger(v) ? Math.min(Math.max(v, 0), max) : 0;
      if (p.action === "sync" && r.phase === "playing" && "rounds" in p) Object.assign(me, { rounds: num(p.rounds, PER), total: num(p.total, 20), right: num(p.right, PER), done: !!p.done });
      if ((p.action === "reset" || p.action === "ready") && r.phase === "over") { // a new game starts: everyone is back in the lobby with a fresh set (Ready after a game does this too)
        r.airports = randomSet(r.mode, "ALL"); r.phase = "lobby"; r.cd = null;
        for (const q of Object.values(r.players)) Object.assign(q, { ready: false, rounds: 0, total: 0, right: 0, done: false });
      }
      if (p.action === "ready" && r.phase === "lobby") me.ready = !!p.value;
      roomTick(r);
      json({ code, day: day(), mode: r.mode, phase: r.phase, cd: r.cd && r.phase === "lobby" ? Math.max(0, r.cd + CD_MS - now) : null, left: r.phase === "playing" ? Math.max(0, r.end - now) : null,
        airports: r.phase === "playing" ? r.airports : undefined, players: Object.entries(r.players).map(([k, q]) => ({ name: q.name, ready: q.ready, rounds: q.rounds, total: q.total, right: q.right, done: q.done, wins: q.wins || 0, me: k === p.id })) });
    });
  }
  // Player feedback after a daily or friend game: one JSON object per line in feedback.jsonl (override the path with FEEDBACK_FILE), e.g.
  // {"t":"2026-11-22T10:00:00.000Z","kind":"daily","day":20779,"mode":"hard","rating":"meh","airports":["KABC"]}
  // rating = fun | meh | hard; airports = the ones the player said bothered them (empty for "fun"). Read it straight from the file,
  // or from GET /api/feedback (all lines as a JSON array; only from this computer, never through a tunnel or proxy).
  if (req.method === "POST" && u.pathname === "/api/feedback") {
    if (limited(req, "feedback", 20)) return json({ error: "Slow down a little." }, 429);
    let b = ""; req.on("data", c => (b += c, b.length > 1e3 && req.destroy()));
    return req.on("end", () => {
      let p; try { p = JSON.parse(b); } catch { return json({ error: "bad json" }, 400); }
      const ok = ["daily", "friend"].includes(p.kind) && Number.isInteger(p.day) && MODES.includes(p.mode) && ["fun", "meh", "hard"].includes(p.rating)
        && Array.isArray(p.airports) && p.airports.length <= PER && p.airports.every(c => ALL.has(c));
      if (!ok) return json({ error: "invalid" }, 400);
      fs.appendFile(FEEDBACK, JSON.stringify({ t: new Date().toISOString(), kind: p.kind, day: p.day, mode: p.mode, rating: p.rating, airports: p.airports }) + "\n", () => {});
      json({ ok: true });
    });
  }
  if (req.method === "GET" && u.pathname === "/api/feedback") {
    const local = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress) && !req.headers["cf-connecting-ip"] && !req.headers["x-forwarded-for"];
    if (!local) return json({ error: "forbidden" }, 403);
    let rows = []; try { rows = fs.readFileSync(FEEDBACK, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch {}
    res.setHeader("access-control-allow-origin", "*"); // so a dashboard page served from another local port can read it
    return json(rows);
  }
  if (req.method === "POST" && u.pathname === "/api/reset") { // dev only: loopback clients can wipe all score stats
    if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress)) return json({ error: "forbidden" }, 403);
    db.scores = {}; db.right = {}; save(); return json({ ok: true });
  }
  if (req.method === "POST" && u.pathname === "/api/score") {
    if (limited(req, "score", 30)) return json({ error: "Slow down a little." }, 429);
    let b = ""; req.on("data", c => (b += c, b.length > 1e3 && req.destroy()));
    return req.on("end", () => {
      let p; try { p = JSON.parse(b); } catch { return json({ error: "bad json" }, 400); }
      const ok = Number.isInteger(p.score) && p.score >= 0 && p.score <= 20 && validId(p.id) && /^(easy|medium|hard)(-city)?$/.test(p.mode) && validDay(p.day) && (p.right === undefined || (Number.isInteger(p.right) && p.right >= 0 && p.right <= PER));
      if (!ok) return json({ error: "invalid" }, 400);
      const k = p.day + ":" + p.mode, d = (db.scores[k] ||= {});
      if (!(p.id in d)) { d[p.id] = p.score; if (p.right !== undefined) (db.right[k] ||= {})[p.id] = p.right; save(); } // first submission per player per day+mode wins
      json(counts(k));
    });
  }
  json({ error: "not found" }, 404);
}).listen(process.env.PORT || 3000, () => console.log("http://localhost:" + (process.env.PORT || 3000)));
// ponytail: JSON file + sync write, one process. Swap for SQLite/Redis if traffic outgrows it. Player id is client-generated, so not cheat-proof; answers are sent to the client.
