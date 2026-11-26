// node server.js — zero dependencies. Serves the page, daily airport sets, and score stats.
const http = require("http"), fs = require("fs");
const SHARES = process.env.SHARES_DIR || "shares", REPORTS = process.env.REPORTS_FILE || "reports.jsonl", FEEDBACK = process.env.FEEDBACK_FILE || "feedback.jsonl", FILE = process.env.DATA_FILE || "data.json", MODES = ["easy", "medium", "hard"], PER = 5;
try { for (const l of fs.readFileSync(".env", "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) process.env[m[1]] ??= m[2]; } } catch {}
const AIR = JSON.parse(fs.readFileSync("airports.json"));
// Lobby trivia: trivia.json is a list of [question, correct answer, three wrong answers, Wikipedia article about the answer]. Each lobby run gets 6 random ones,
// with the answer positions shuffled; the answer key stays on the server and is only revealed to a player question by question, as they answer.
// Study tips: learn.json maps an airport code to a few "how to recognise it" notes (runway layout, nearby water or mountains, roads, terminal shape). Only the Normal airports have them.
let LEARN = {}; try { LEARN = JSON.parse(fs.readFileSync("learn.json", "utf8")); } catch {}
let TRIVIA = []; try { TRIVIA = JSON.parse(fs.readFileSync("trivia.json", "utf8")); } catch {}
const TQ = 6;
function newTrivia() {
  if (TRIVIA.length < TQ) return null;
  const pool = TRIVIA.slice(), qs = [];
  while (qs.length < TQ) {
    const [q, c, x, y, z, w] = pool.splice(Math.floor(Math.random() * pool.length), 1)[0], o = [c, x, y, z];
    for (let i = 3; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } // Fisher–Yates
    qs.push({ q, o, a: o.indexOf(c), w });
  }
  return { id: Math.random().toString(36).slice(2, 8), qs, ans: Object.create(null), due: 0, final: null, again: new Set() };
}
// Who can play this lobby's trivia: pages that show it (not phones), plus anyone who has answered. Watchers who joined during a game don't count.
const triviaPlayers = r => Object.entries(r.players).filter(([k, q]) => !q.late && (q.tvOk || (r.trivia.ans[k] || []).some(v => v != null)));
const triviaDone = (t, k) => t.qs.every((_, i) => (t.ans[k] || [])[i] != null);
// Play again is open once the winner is locked, or when there is nobody to compete with (so a lone player is never stuck).
const voteOpen = (r, can) => !!r.trivia.final || (can.length < 2 && can.some(([k]) => triviaDone(r.trivia, k)));
// The winner is locked when everyone who can play has finished, or TV_MS after the first one finished (with at least two able to play), whichever comes first.
// Only those who finished by then can win, it takes two of them and at least one right answer, and it never changes afterwards.
// Then half of the trivia players (rounded up) voting to play again deals new questions.
const TV_MS = 60 * 1000;
function triviaTick(r, now) {
  const t = r.trivia; if (!t) return;
  const can = triviaPlayers(r), fin = can.filter(([k]) => triviaDone(t, k));
  if (!t.final) {
    if (!t.due && can.length > 1 && fin.length) t.due = now + TV_MS;
    if ((can.length > 1 && fin.length === can.length) || (t.due && now >= t.due)) {
      const score = k => t.qs.filter((x, i) => t.ans[k][i] === x.a).length, top = Math.max(0, ...fin.map(([k]) => score(k)));
      const best = fin.length > 1 && top > 0 ? fin.filter(([k]) => score(k) === top) : [];
      t.final = { in: new Set(fin.map(([k]) => k)), win: new Set(best.map(([k]) => k)), names: best.map(([, q]) => q.name) };
    }
  }
  if (voteOpen(r, can)) { const yes = can.filter(([k]) => t.again.has(k)).length; if (yes && yes >= Math.ceil(can.length / 2)) r.trivia = newTrivia(); }
}
// What one player may see of the trivia: the questions (once), their own answers with the key for those, and everyone's right/wrong only after they have finished all of them.
// The locked winner's name goes to everyone, also phones and players who never answered.
function triviaFor(r, id, tv) {
  const t = r.trivia; if (!t) return undefined;
  const mine = t.ans[id] || [], f = t.final, mark = k => ({ in: !!f && f.in.has(k), win: !!f && f.win.has(k) });
  const out = { id: t.id, mine: t.qs.map((x, i) => mine[i] == null ? null : { c: mine[i], a: x.a }), final: !!f, due: !f && t.due ? Math.max(0, t.due - Date.now()) : null, me: mark(id) };
  if (tv !== t.id) out.qs = t.qs.map(x => ({ q: x.q, o: x.o, w: x.w }));
  if (triviaDone(t, id)) out.others = Object.entries(r.players).filter(([k, q]) => k !== id && !q.late).map(([k, q]) => ({ name: q.name, ...mark(k), res: t.qs.map((x, i) => { const v = (t.ans[k] || [])[i]; return v == null ? null : v === x.a ? 1 : 0; }), pick: t.qs.map((x, i) => (t.ans[k] || [])[i] ?? null) })); // pick = the option each one chose
  if (f && f.names.length) out.win = f.names;
  const can = triviaPlayers(r);
  out.again = { open: voteOpen(r, can), yes: can.filter(([k]) => t.again.has(k)).length, need: Math.max(1, Math.ceil(can.length / 2)), mine: t.again.has(id) };
  return out;
}
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
// A bug or a failed disk write must never take the server down: log it and keep serving (a request that hit it just times out).
process.on("uncaughtException", e => console.error("uncaught:", e)); process.on("unhandledRejection", e => console.error("unhandled:", e));
const day = () => Math.floor(Date.now() / 864e5), save = () => { try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { console.error("save failed:", e.message); } };
// The tunnel always connects to this port from loopback, whatever the real visitor's address; a request that reaches this port some other way (an exposed
// port, a misconfigured route) is not coming through the tunnel at all, loopback or not.
const LOOPBACK = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/;
// Loopback only, and not through the tunnel: the tunnel connects from this machine too, but adds these headers.
// Also refused: any proxy header, a Host that is not localhost (DNS rebinding: a hostile site pointing its own name at 127.0.0.1), and a browser request that
// comes from another site (a hostile page POSTing to localhost, or reading the answer). Scripts like curl send no Origin and still work.
const isLocal = req => { const h = req.headers;
  return LOOPBACK.test(req.socket.remoteAddress) && !h["cf-connecting-ip"] && !h["x-forwarded-for"] && !h["x-forwarded-host"] && !h["forwarded"] && !h["x-real-ip"] && !h["cf-ray"]
    && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h.host || "") && (!h.origin || h.origin.toLowerCase() === "http://" + h.host.toLowerCase()) && !/cross-site|same-site/.test(h["sec-fetch-site"] || ""); };

function ensure(d) {
  let changed = db.first == null; // only write the file when something new was made (this runs on every /api/today request)
  db.first ??= d; // the archive starts the day this database was first started
  for (const m of MODES) {
    if (db.sets[d + ":" + m]) continue;
    let pool = AIR[m].filter(a => !(db.used[m] || []).includes(a[0]));
    if (pool.length < PER) { db.used[m] = []; pool = AIR[m].slice(); } // pool exhausted: start over (a copy: splice below must not eat the airport list itself)
    const pick = [];
    while (pick.length < PER) pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    db.sets[d + ":" + m] = pick;
    (db.used[m] ||= []).push(...pick.map(a => a[0])); changed = true;
  }
  if (changed) save();
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
// Clues for the City and state game. nearMajor(a): the closest major (Normal-tier) airport and which way this one lies from it, e.g. ["KSYR","Syracuse",46,"SW"].
// DOT: every airport projected onto a small grid, as one SVG path of dots, so the page can draw the country from the airports themselves (no map tiles) and mark the answer.
const RAD = Math.PI / 180, COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const bearing = (a, b, c, d) => { const y = Math.sin((d - b) * RAD) * Math.cos(c * RAD), x = Math.cos(a * RAD) * Math.sin(c * RAD) - Math.sin(a * RAD) * Math.cos(c * RAD) * Math.cos((d - b) * RAD); return (Math.atan2(y, x) / RAD + 360) % 360; };
function nearMajor(a) {
  let best = null;
  for (const m of AIR.easy) { if (m[0] === a[0]) continue; const d = dist(a[3], a[4], m[3], m[4]); if (!best || d < best[0]) best = [d, m]; }
  const [d, m] = best; return [m[0], m[1], Math.round(d), COMPASS[Math.round(bearing(m[3], m[4], a[3], a[4]) / 45) % 8]];
}
const DOT = { w: 240, h: 144, lon0: -125, lon1: -66.5, lat0: 24.5, lat1: 49.5 };
DOT.d = [...new Set([...ALL.values()].filter(a => a[3] >= DOT.lat0 && a[3] <= DOT.lat1 && a[4] >= DOT.lon0 && a[4] <= DOT.lon1)
  .map(a => Math.round((a[4] - DOT.lon0) / (DOT.lon1 - DOT.lon0) * DOT.w) + " " + Math.round((DOT.lat1 - a[3]) / (DOT.lat1 - DOT.lat0) * DOT.h)))].map(p => "M" + p + "h0").join("");
// The airports a custom game can pick from in a state: the chosen difficulty's own airports there, plus the next difficulty's only if there are fewer than five.
const tiersOf = mode => mode === "all" ? [["easy", "medium", "hard"].flatMap(t => AIR[t])] : ORDER[mode].map(t => AIR[t]); // "all" (lobby custom games): every difficulty together, no preference
const candidates = (mode, st) => { const out = []; for (const list of tiersOf(mode)) { out.push(...list.filter(a => a[2] === st)); if (out.length >= PER) break; } return out; };
function randomSet(mode, st, skip = []) { // skip = airport codes the lobby host switched off
  const pick = [], seen = new Set();
  for (const list of tiersOf(mode)) { const pool = list.filter(a => (st === "ALL" || a[2] === st) && !skip.includes(a[0])); while (pick.length < PER && pool.length) { const a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]; if (!seen.has(cityKey(a))) { seen.add(cityKey(a)); pick.push(a); } } }
  return pick.map(a => [...a, altsOf(a), nearMajor(a)]);
}
// "Play a friend": a 4-letter code shares one random set between two players. In memory only (a restart ends open games); rooms expire after a day.
const rooms = new Map(), MAX_ROOMS = 300;
let FIND = null; // search table for /api/find, built on first use
const normFind = t => String(t ?? "").toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/ +/g, " ").trim(); // lower case, apostrophes dropped, other punctuation = a space
const FIND_ALIAS = { ohare: "KORD", laguardia: "KLGA", seatac: "KSEA", mccarran: "KLAS", idlewild: "KJFK", liberty: "KEWR", dulles: "KIAD", reagan: "KDCA", hartsfield: "KATL", kennedy: "KJFK", logan: "KBOS" }; // famous names (spaces removed) the airport's official name doesn't spell the same way
// A lobby's game settings (cfg), set by the lobby owner: kind easy | medium | hard (Normal / Hard / Extra Hard), custom (format, state, difficulty) or zip (airports near a ZIP).
// genSet makes the five airports for the current settings (a zip lobby keeps the ZIP's coordinates in r.zp).
function genSet(r) {
  const c = r.cfg, off = new Set(c.off || []), row = a => [...a, altsOf(a), nearMajor(a)];
  let pool, dedupe = false;
  if (c.kind === "zip") pool = [...ALL.values()].filter(a => dist(r.zp.lat, r.zp.lon, a[3], a[4]) <= c.miles && !off.has(a[0])); // off = airports the host switched off
  else if (c.kind === "list") pool = c.list.map(x => ALL.get(x)).filter(Boolean); // the host's own typed list: exactly these airports
  else if (c.kind === "custom" && c.st) { pool = candidates(c.mode, c.st).filter(a => !off.has(a[0])); dedupe = true; }
  else return randomSet(c.mode, c.st || "ALL", []);
  const pick = [], seen = new Set(); // five at random from the pool (fewer if the pool is smaller; none if every airport is switched off)
  while (pick.length < PER && pool.length) { const a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]; if (dedupe && seen.has(cityKey(a))) continue; seen.add(cityKey(a)); pick.push(a); }
  return pick.map(row);
}
// Everything a player types or sends is untrusted. Names: no control, invisible or direction-changing characters, no angle brackets, one space between words, 12 characters.
const NAME_BAD = new RegExp("[" + [[0, 31], [127, 159], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]].map(([x, y]) => String.fromCharCode(x) + "-" + String.fromCharCode(y)).join("") + "<>]", "g"); // control, zero-width, line/paragraph separators, direction overrides, BOM, angle brackets
const cleanName = t => [...String(t ?? "").replace(NAME_BAD, "").replace(/\s+/g, " ").trim()].slice(0, 12).join("");
const validId = t => typeof t === "string" && /^[\w-]{1,64}$/.test(t); // player ids are random UUIDs; "__proto__" still passes, which is safe because lobby players and trivia answers are null-prototype objects and scores are only written when the id is not already "in" the object
// A small rate limit per client address (behind a tunnel the real address is in a header): at most N requests a minute per route.
const hits = new Map();
// capped: used only as a rate-limit bucket key, never trusted for anything else. The proxy headers are honored only when the connection really is the
// tunnel's own loopback hop (see LOOPBACK above) -- otherwise this port was reached some other way, and the headers are just more attacker-supplied text
// that would let one visitor claim a fresh "address" on every request and dodge every limiter below.
const clientIp = req => { const real = String(req.socket.remoteAddress || "");
  if (!LOOPBACK.test(real)) return real.slice(0, 64);
  return String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || real).split(",")[0].trim().slice(0, 64); };
function limited(req, route, max) {
  const now = Date.now(), k = route + "|" + clientIp(req); let h = hits.get(k);
  if (!h || now - h.t > 60000) {
    if (hits.size > 20000) { for (const [x, v] of hits) if (now - v.t > 60000) hits.delete(x); if (hits.size > 20000) hits.clear(); } // drop only expired windows first, so a flood of fake addresses can't wipe everyone else's counters
    hits.set(k, h = { t: now, n: 0 });
  }
  return ++h.n > max;
}
const roomCode = () => { for (;;) { const c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.random() * 24 | 0]).join(""); if (!rooms.has(c)) return c; } };
// A host-typed airport list: an array of at most 100 airport codes, every one of which must be a real airport we know (anything else is dropped, never stored). Returns undefined for no list.
const cleanList = l => { if (!Array.isArray(l)) return undefined; const out = []; for (const x of l.slice(0, 100)) { const c = typeof x === "string" ? x.trim().toUpperCase() : ""; if (/^[A-Z0-9]{3,4}$/.test(c) && ALL.has(c) && !out.includes(c)) out.push(c); } return out.length ? out : undefined; };
const MAXP = 5, CD_MS = 5000, GAME_MS = 5 * 60000, HOST_QUIET_MS = 90000, MIN_ROUND_MS = 1200; // a guess can't be legitimately typed and checked faster than this
// Lobby time-outs (never while a game is being played): 5 minutes with nothing happening (nobody joining, leaving, renaming, pressing Ready or starting over;
// the page checking in does not count), and 10 minutes since the lobby opened or the last game ended without a new game starting, which keeps a lobby that
// keeps almost-starting (everyone readies, someone backs out) from lasting forever. A timed-out lobby tells its players once, then disappears.
const IDLE_MS = +process.env.ROOM_IDLE_MS || 5 * 60000, NOSTART_MS = +process.env.ROOM_NOSTART_MS || 10 * 60000;
// What a player guessed, round by round, for the lobby's round maps: only "skip" or a K code gets through, never more than the game has room for.
const cleanLog = v => Array.isArray(v) ? v.slice(0, PER).map(r => Array.isArray(r) ? r.slice(0, 4).filter(g => typeof g === "string" && /^(skip|K[A-Z]{3})$/.test(g)) : []) : [];
// Where a finished game's round maps put things: each answer, the other right answers (City and state games), and every real airport somebody guessed.
function roundMap(r, ps) {
  const at = {}; for (const q of ps) for (const g of (q.log || []).flat()) { const a = ALL.get(g); if (a) at[g] = [a[3], a[4]]; }
  return { ans: r.airports.map(a => [a[3], a[4]]), alts: r.airports.map(a => r.cfg.fmt === "city" ? (a[8] || []).map(x => x[0]) : []), at };
}
// Lobby -> playing -> over. Everyone Ready (2 or more) starts a 5-second countdown that any un-ready cancels; then 5 minutes; over when all are done or time is up.
function roomTick(r) {
  const now = Date.now();
  if (!r.closed && r.phase !== "playing") {
    if (now - r.act > IDLE_MS) r.closed = { why: "idle", at: now };
    else if (now - r.since > NOSTART_MS) r.closed = { why: "nostart", at: now };
  }
  if (r.closed) return;
  if (r.phase === "lobby") {
    for (const [k, q] of Object.entries(r.players)) { // players who closed the page
      // The host gets longer unless the page said it was closing: a browser can slow a hidden tab to one check-in a minute, and that mustn't close everyone's lobby.
      if (now - q.seen <= (k === r.owner && !q.away ? HOST_QUIET_MS : 15000)) continue;
      if (k === r.owner) { r.closed = { why: "host", at: now }; return; } // no host, no lobby
      delete r.players[k];
    }
    triviaTick(r, now);
    const ps = Object.values(r.players);
    if (ps.length >= 2 && ps.every(q => q.ready)) r.cd ??= now; else r.cd = null;
    if (r.cd && now - r.cd >= CD_MS) { r.phase = "playing"; r.end = r.cd + CD_MS + GAME_MS; }
  }
  if (r.phase === "playing" && (now >= r.end || Object.values(r.players).filter(q => !q.late).every(q => q.done))) {
    r.phase = "over"; r.act = r.since = now; const all = Object.values(r.players), ps = all.filter(q => !q.late); for (const q of all) q.done = true;
    const top = Math.max(...ps.map(q => q.total)); if (ps.length > 1) for (const q of ps) if (q.total === top) q.wins = (q.wins || 0) + 1; // a win (a star) for the top score; ties share it
    // The lobby remembers its finished games (newest last, the last 15): what was played and everyone's result. Sent to a page only when it has changed.
    if (ps.length) { r.games = (r.games || 0) + 1; (r.history ||= []).push({ n: r.games, cfg: { ...r.cfg }, codes: r.airports.map(a => a[0]), ...roundMap(r, ps), players: ps.map(q => ({ name: q.name, total: q.total, right: q.right, streak: q.streak || 0, fin: q.fin ?? null, log: q.log || [] })).sort((a, b) => b.total - a.total) }); if (r.history.length > 15) r.history.shift(); } // (a game nobody finished, because everyone left, isn't recorded)
  }
}
const zips = new Map();
async function zipPoint(zip) {
  if (zips.has(zip)) return zips.get(zip);
  if (!/^\d{5}$/.test(zip)) return null; // the only thing that is ever put in the outside address: exactly five digits, to the one fixed host
  const r = await fetch("https://api.zippopotam.us/us/" + zip, { signal: AbortSignal.timeout(5000), redirect: "error" }); // never follow a redirect to another host
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("lookup failed");
  const pl = (await r.json()).places[0], p = { lat: +pl.latitude, lon: +pl.longitude };
  if (!(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)) throw new Error("bad lookup answer"); // also catches NaN
  if (zips.size >= 20000) zips.delete(zips.keys().next().value); // the cache never grows past 20,000 ZIPs (oldest goes first)
  zips.set(zip, p); return p;
}
// Static files: the page, its stylesheet, the game audio module, and the uisfx player (a self-contained ES module).
const STATIC = { "/style.css": "style.css", "/sfx.js": "sfx.mjs", "/vendor/uisfx.js": "node_modules/uisfx/dist/index.js",
  // the game's icon: browser tab (SVG, plus a 32 px PNG for Safari), iPhone/iPad home screen, and the install manifest
  "/icon.svg": "icons/icon.svg", "/icon-32.png": "icons/icon-32.png", "/apple-touch-icon.png": "icons/apple-touch-icon.png", "/icon-192.png": "icons/icon-192.png", "/icon-512.png": "icons/icon-512.png", "/site.webmanifest": "icons/site.webmanifest" };
// Cache busting: the page asks for /style.css?v=<hash of the files>, so after an update every visitor (and Cloudflare) sees a new address and fetches the new file.
const VERSION = require("crypto").createHash("md5").update(["style.css", "sfx.mjs", "node_modules/uisfx/dist/index.js"].map(f => fs.readFileSync(f)).join("")).digest("hex").slice(0, 10);
const APP_VERSION = JSON.parse(fs.readFileSync("package.json", "utf8")).version; // shown in the page footer: bump "version" in package.json when you release
const page = () => fs.readFileSync("index.html", "utf8").replace("__VERSION__", APP_VERSION).replace(/(\/style\.css|\/sfx\.js|\/vendor\/uisfx\.js)(?=["'])/g, "$1?v=" + VERSION);
const TYPES = { html: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", jpg: "image/jpeg", svg: "image/svg+xml", png: "image/png", webmanifest: "application/manifest+json" };
// The page, stylesheet and scripts are sent with no-cache so browsers and Cloudflare re-check them, so an update shows up right away instead of after a stale copy expires.
// A file that is missing on disk answers 404 instead of crashing the server.
const serve = (res, f, cache = "no-cache") => { let body; try { body = fs.readFileSync(f); } catch { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); } res.writeHead(200, { "content-type": TYPES[f.split(".").pop()] || "application/octet-stream", "cache-control": cache }); res.end(body); };
// Every 30 seconds: let lobbies tidy themselves (players who left are dropped) and delete lobbies nobody is in.
setInterval(() => { const now = Date.now(); for (const [k, r] of rooms) { roomTick(r); if (!Object.keys(r.players).length || (r.closed && now - r.closed.at > 300000)) rooms.delete(k); } }, 30000).unref();
// An unexpected throw in a handler (sync, in a promise, or in a request-body callback) answers 500 instead of leaving the request hanging; it is still logged.
const fail = (res, e) => { console.error("request failed:", e); try { if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" }); res.end('{"error":"server error"}'); } else res.end(); } catch {} };
const safe = (res, fn) => async (...a) => { try { await fn(...a); } catch (e) { fail(res, e); } };
const server = http.createServer({ maxHeaderSize: 8192, connectionsCheckingInterval: 2000 },(req, res) => { try { handle(req, res); } catch (e) { fail(res, e); } }).on("error", e => { console.error("server error:", e); process.exit(1); }); // the crash guard above would hide a failed start (port in use): a dead server must exit so Docker restarts it
// Slow-client limits (slowloris): the whole request head within 10 s, the whole request within 30 s, idle keep-alive connections closed after 5 s, and a cap on connections.
Object.assign(server, { headersTimeout: 10000, requestTimeout: 30000, keepAliveTimeout: 65000, maxConnections: 1000 }); server.maxRequestsPerSocket = 200; // keepAliveTimeout is above the tunnel's idle time (Node's 5 s default makes a reused tunnel connection fail with a 502); headersTimeout stays short for slowloris, and an idle kept-alive connection is not affected by it (tested)
server.listen(process.env.PORT || 3000, () => console.log("http://localhost:" + (process.env.PORT || 3000)));
function handle(req, res) {
  res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "strict-origin-when-cross-origin"); // (not "same-origin": that sends Google Maps no Referer, which breaks a key restricted by referrer)
  res.setHeader("content-security-policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'"); // no framing, no <base> tricks, no plugins
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"); res.setHeader("cross-origin-opener-policy", "same-origin"); res.setHeader("x-frame-options", "DENY");
  if (req.headers["x-forwarded-proto"] === "https") res.setHeader("strict-transport-security", "max-age=15552000"); // only when it arrived over https (through the tunnel)
  let u; try { u = new URL(req.url, "http://x"); } catch { res.writeHead(400); return res.end(); } // a malformed address (e.g. "//") must not throw
  if (limited(req, "all", 900)) { res.writeHead(429, { "content-type": "application/json", "cache-control": "no-store", "retry-after": "30" }); return res.end('{"error":"Slow down a little."}'); } // one address: 900 requests a minute in all, so no route can be used to hammer the server
  // A browser tells us when a request comes from another website. Nothing here is meant to be called that way, so a cross-site POST (a form or fetch on someone else's page) is refused.
  if (req.method === "POST" && req.headers["sec-fetch-site"] === "cross-site") { res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" }); return res.end('{"error":"forbidden"}'); }
  const mode = u.searchParams.get("mode"), json = (o, s = 200) => (res.writeHead(s, { "content-type": "application/json", "cache-control": "no-store" }), res.end(JSON.stringify(o)));
  if (req.method === "GET" && u.pathname === "/") { // the page gets the full Content-Security-Policy: only its own script (marked with a fresh random nonce each time) and what that script loads (Google Maps) may run
    const n = require("crypto").randomBytes(16).toString("base64"), g = "https://*.googleapis.com https://*.gstatic.com https://*.google.com";
    res.setHeader("content-security-policy", ["default-src 'self'", `script-src 'nonce-${n}' 'strict-dynamic'`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", `img-src 'self' data: blob: ${g} https://*.ggpht.com`,
      "font-src 'self' https://fonts.gstatic.com data:", `connect-src 'self' ${g}`, "worker-src blob:", "frame-src 'none'", "media-src 'self' blob: data:", "manifest-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'"].join("; "));
    return (res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache" }), res.end(page().replace("<script>", `<script nonce="${n}">`)));
  }
  if (req.method === "GET" && STATIC[u.pathname]) return serve(res, STATIC[u.pathname]);
  if (req.method === "GET" && u.pathname === "/chart.jpg") { // today's faint background chart
    const f = chartOfTheDay();
    return f ? (res.setHeader("cache-control", "max-age=600"), serve(res, "charts/" + f)) : json({ error: "no charts" }, 404);
  }
  if (req.method === "GET" && u.pathname === "/api/sounds") return json(fs.existsSync("sounds") ? fs.readdirSync("sounds").filter(f => /\.(mp3|wav|ogg)$/.test(f)) : []); // which of your sound files exist (so the page never probes for missing ones)
  if (req.method === "GET" && /^\/sounds\/[\w.-]+\.(mp3|wav|ogg)$/.test(u.pathname)) // sound effects you drop in ./sounds
    return fs.existsSync("." + u.pathname) ? serve(res, "." + u.pathname, "public, max-age=3600") : json({ error: "not found" }, 404);
  if (req.method === "GET" && u.pathname === "/api/config") { // the Maps key is meant for this page (restrict it by referrer in Google Cloud); a browser does not hand it to another website's script
    if (req.headers["sec-fetch-site"] === "cross-site") return json({ error: "forbidden" }, 403);
    return json({ key: process.env.GOOGLE_MAPS_KEY || "" });
  }
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
    if (limited(req, "near", 30)) return json({ error: "Slow down a little." }, 429); // each new ZIP is an outside lookup
    if (!/^\d{5}$/.test(zip) || ![25, 50, 100, 250, 500].includes(miles)) return json({ error: "Enter a 5-digit ZIP code." }, 400);
    return zipPoint(zip).then(p => {
      if (!p) return json({ error: "Couldn't find that ZIP code." }, 404);
      const near = [...ALL.values()].filter(a => dist(p.lat, p.lon, a[3], a[4]) <= miles), pick = [];
      while (pick.length < PER && near.length) pick.push(near.splice(Math.floor(Math.random() * near.length), 1)[0]);
      json(pick.length ? { day: day(), airports: pick } : { error: `No airports within ${miles} miles of ${zip}. Try a bigger distance.` });
    }).catch(() => json({ error: "Couldn't look that ZIP up right now. Try again." }, 502));
  }
  if (req.method === "GET" && u.pathname === "/api/within") { // the airports inside a radius, for the zip lobby's map: [[code, lat, lon], ...]
    const lat = +u.searchParams.get("lat"), lon = +u.searchParams.get("lon"), miles = +u.searchParams.get("miles");
    if (limited(req, "within", 60)) return json({ error: "Slow down a little." }, 429);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || ![25, 50, 100, 250, 500].includes(miles)) return json({ error: "bad request" }, 400);
    return json([...ALL.values()].filter(a => dist(lat, lon, a[3], a[4]) <= miles).map(a => [a[0], a[3], a[4], a[1], a[2]]));
  }
  if (req.method === "GET" && u.pathname === "/api/airports") { // the airports a custom game can pick in a state at a difficulty (?state=TX&mode=easy), for the custom lobby's list: [[code, lat, lon, city, state], ...]
    const st = u.searchParams.get("state"), m = u.searchParams.get("mode") || "easy";
    if (!STATES.includes(st) || !(MODES.includes(m) || m === "all")) return json({ error: "bad request" }, 400);
    return json(candidates(m, st).map(a => [a[0], a[3], a[4], a[1], a[2]]));
  }
  if (req.method === "GET" && u.pathname === "/api/list") { // single-player "Custom List": ?codes=KORD,KMDW,... -> five of those at random (or fewer): { day, airports }
    if (limited(req, "list", 60)) return json({ error: "Slow down a little." }, 429);
    const list = cleanList(String(u.searchParams.get("codes") || "").slice(0, 800).split(","));
    if (!list) return json({ error: "Add at least one airport." }, 400);
    const pool = list.map(c => ALL.get(c)), pick = [];
    while (pick.length < PER && pool.length) pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return json({ day: day(), airports: pick.map(a => [...a, altsOf(a), nearMajor(a)]) });
  }
  if (req.method === "GET" && u.pathname === "/api/find") { // airport search for the lobby's typed list: ?q=chicago (top 5 matches) or ?codes=KORD,KMDW (look those up): [[code, city, state, name], ...]
    if (limited(req, "find", 150)) return json({ error: "Slow down a little." }, 429);
    const row = a => [a[0], a[1], a[2], a[6]];
    if (u.searchParams.has("codes")) return json(String(u.searchParams.get("codes")).slice(0, 800).toUpperCase().split(",").slice(0, 100).map(c => /^[A-Z0-9]{3,4}$/.test(c) && (ALL.has(c) ? c : ALL.has("K" + c) && c.length === 3 ? "K" + c : "")).filter(Boolean).map(c => row(ALL.get(c)))); // a pasted "ORD" is read as KORD when only the K form exists
    const q = normFind(u.searchParams.get("q")).slice(0, 30).trim(), qk = q.replace(/ /g, ""); // apostrophes and punctuation never break a match ("o'hare" = "ohare")
    if (!q) return json([]);
    if (!FIND) { const tier = new Map(), famous = new Set(Object.values(FIND_ALIAS)); // the famous airports (O'Hare, JFK...) come first of all ["easy", "medium", "hard"].forEach((t, i) => AIR[t].forEach(a => tier.has(a[0]) || tier.set(a[0], i)));
      FIND = [...ALL.values()].map(a => ({ a, t: famous.has(a[0]) ? -1 : tier.get(a[0]) ?? 3, code: a[0].toLowerCase(), bare: a[0].slice(1).toLowerCase(), city: normFind(a[1]), name: normFind(a[6]), st: a[2].toLowerCase() })); }
    // Best match first; among equal matches the well-known airports (Normal, then Hard, then Extra Hard) come before small ones, so "chicago" gives O'Hare before Aurora.
    const score = f => f.code === q || f.bare === q || FIND_ALIAS[qk] === f.a[0] ? 0 : f.code.startsWith(q) || f.bare.startsWith(q) ? 1 : f.city === q ? 1.5 : f.city.startsWith(q) ? 2 : f.city.includes(q) || f.name.includes(q) ? 3 : (q.length === 2 && f.st === q) ? 4 : 9;
    return json(FIND.map(f => [score(f), f]).filter(x => x[0] < 9).sort((x, y) => x[0] - y[0] || x[1].t - y[1].t || (x[1].code < y[1].code ? -1 : 1)).slice(0, 5).map(x => row(x[1].a)));
  }
  if (req.method === "GET" && u.pathname === "/api/dots") return (res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=86400" }), res.end(JSON.stringify(DOT))); // the locator-map dots (never changes)
  if (req.method === "GET" && u.pathname === "/api/learn") { // ?codes=KATL,KJFK -> { KATL: [tips], ... } for the ones we have notes on (asked for after a game, so no spoilers)
    const out = {}; for (const c of String(u.searchParams.get("codes") || "").toUpperCase().split(",").slice(0, 10)) if (/^[A-Z0-9]{3,4}$/.test(c) && LEARN[c]) out[c] = LEARN[c];
    return json(out);
  }
  if (req.method === "GET" && u.pathname === "/api/states") return json(STATES);
  if (req.method === "GET" && u.pathname === "/api/archive") return json({ first: db.first }); // the earliest day players can go back to
  if (req.method === "GET" && u.pathname === "/api/state") { // practice game: 5 random airports in a state, from the chosen difficulty first, topped up from the others
    const st = u.searchParams.get("state");
    if (!(MODES.includes(mode) || mode === "all") || (st !== "ALL" && !STATES.includes(st))) return json({ error: "bad request" }, 400); // "ALL" = any state; mode "all" = every difficulty mixed (the Custom Game's "All")
    return json({ day: day(), airports: randomSet(mode, st) });
  }
  if (req.method === "GET" && u.pathname === "/api/today") {
    if (!MODES.includes(mode)) return json({ error: "bad mode" }, 400);
    const d = u.searchParams.has("day") ? +u.searchParams.get("day") : day(); // ?day=N (a UTC day number) opens an earlier day from the archive
    if (!validDay(d)) return json({ error: "day out of range" }, 400);
    ensure(day()); return json({ day: d, airports: setFor(d, mode) });
  }
  if (req.method === "POST" && u.pathname === "/api/room") { // action: create {name} | config {kind, ...} (owner only) | join {code, name} | sync {code, rounds, total, right, done} | ready {code, value} | trivia {q, choice} | again {tv, value} | away {code} | reset {code} | touch {code} (owner only)
    if (limited(req, "room", 600)) return json({ error: "Slow down a little." }, 429);
    let b = ""; req.on("data", c => (b += c, b.length > 3e3 && req.destroy())); // 3 KB at most (a typed airport list is up to 100 codes)
    return req.on("end", safe(res, async () => {
      let p; try { p = JSON.parse(b); } catch { return json({ error: "bad json" }, 400); }
      if (!p || typeof p !== "object" || !validId(p.id)) return json({ error: "bad request" }, 400);
      const now = Date.now(), name = cleanName(p.name); let r, code = String(p.code || "").toUpperCase(), zp = null;
      if (p.action === "config" && p.kind === "zip") { // a ZIP is looked up before anything changes (and only for the owner, at most 20 a minute)
        const z = String(p.zip || ""), mi = +p.miles;
        if (!/^[0-9]{5}$/.test(z) || ![25, 50, 100, 250, 500].includes(mi)) return json({ error: "Enter a 5-digit ZIP code." }, 400);
        if (limited(req, "roomzip", 20)) return json({ error: "Slow down a little." }, 429);
        if (rooms.get(code)?.owner !== p.id) return json({ error: "Only the lobby owner can change that." }, 403);
        try { zp = await zipPoint(z); } catch { return json({ error: "Couldn't look that ZIP up right now. Try again." }, 502); }
        if (!zp) return json({ error: "Couldn't find that ZIP code." }, 404);
        if (![...ALL.values()].some(a => dist(zp.lat, zp.lon, a[3], a[4]) <= mi)) return json({ error: `No airports within ${mi} miles of ${z}. Try a bigger distance.` }, 404);
      }
      if (p.action === "create") {
        if (limited(req, "roomnew", 20)) return json({ error: "Slow down a little." }, 429); // one address can't fill all the lobby slots
        if (!name) return json({ error: "Enter your name." }, 400);
        for (const [k, v] of rooms) if (now - v.at > 864e5) rooms.delete(k);
        if (rooms.size >= MAX_ROOMS) return json({ error: "Too many games right now. Try again in a bit." }, 503);
        code = roomCode(); rooms.set(code, r = { mode: "easy", cfg: { kind: "easy", mode: "easy", fmt: "map", st: "" }, owner: p.id, airports: randomSet("easy", "ALL"), players: Object.create(null), phase: "lobby", cd: null, end: 0, at: now, act: now, since: now, trivia: newTrivia() });
      } else if (!(r = rooms.get(code))) return json({ error: "No game with that code." }, 404);
      roomTick(r); // also notices a lobby that has timed out
      if (r.closed) return p.action === "sync" && p.id in r.players ? json({ error: r.closed.why === "host" ? "The host left." : "The lobby timed out.", timeout: r.closed.why }, 410) : json({ error: "No game with that code." }, 404);
      if (p.action === "leave") { // leaving takes you off the list at once (an empty game is deleted)
        if (p.id in r.players) r.act = now; // only a real member's leaving counts as activity (a stranger can't keep a lobby alive)
        const host = p.id === r.owner;
        delete r.players[p.id]; if (!Object.keys(r.players).length) rooms.delete(code); else if (host) r.closed = { why: "host", at: now }; else roomTick(r); // the host leaving closes the lobby, even mid-game
        return json({ left: true });
      }
      let me = r.players[p.id];
      if (!me) { // new players: create / join only, and only before the game starts
        if (p.action !== "create" && p.action !== "join") return json({ error: "You're no longer in that game." }, 410);
        if (!name) return json({ error: "Enter your name." }, 400);
        if (Object.keys(r.players).length >= MAXP) return json({ error: "That game is full." }, 409);
        me = r.players[p.id] = { name, ready: false, rounds: 0, total: 0, right: 0, done: false, late: r.phase !== "lobby" }; // late = joined while a game is on (or just finished)
      }
      if (typeof p.tvOk === "boolean") me.tvOk = p.tvOk; // does this player's page show the lobby trivia?
      me.seen = now; if (name) { if (name !== me.name) r.act = now; me.name = name; }
      me.away = p.action === "away";
      if (me.away) { me.seen = now - 10000; me.ready = false; } // the page is closing or reloading: in a lobby the seat goes 5 s from now unless they're back (a game in progress keeps it)
      if (p.action === "join" || p.action === "ready" || p.action === "reset") r.act = now; // things people do count as activity; plain check-ins do not
      if (p.action === "touch" && r.owner === p.id && r.phase !== "playing") r.act = r.since = now; // the host pressing anything in the lobby starts both closing timers over
      const num = (v, max) => Number.isInteger(v) ? Math.min(Math.max(v, 0), max) : 0;
      // A player's own progress is still self-reported (there is no server-side answer check, by design -- see README), but it must at least be as slow
      // as a human actually playing: at MIN_ROUND_MS per round, claiming more rounds than the elapsed time allows is clamped away, so a single forged
      // "I'm already done with a perfect score" sync sent right after the round starts can claim 0 rounds, not 5.
      if (p.action === "sync" && r.phase === "playing" && !me.late && "rounds" in p) {
        const n = r.airports.length, maxRounds = Math.min(n, Math.max(0, Math.floor((now - (r.end - GAME_MS)) / MIN_ROUND_MS))), rounds = Math.min(num(p.rounds, n), maxRounds);
        Object.assign(me, { rounds, total: Math.min(num(p.total, n * 4), rounds * 4), right: Math.min(num(p.right, n), rounds), streak: Math.min(num(p.streak, n), rounds), done: !!p.done && rounds >= n });
      }
      if (p.action === "sync" && r.phase === "playing" && !me.late && "log" in p) me.log = cleanLog(p.log); // not sent to anyone until the game is over
      if (p.action === "sync" && r.phase === "playing" && !me.late && me.done && me.fin == null) me.fin = Math.max(0, now - (r.end - GAME_MS)); // when this player finished, in ms from the start of the game (stays empty if the time ran out)
      if ((p.action === "reset" || p.action === "ready") && r.phase === "over") { // a new game starts: everyone is back in the lobby with a fresh set (Ready after a game does this too)
        r.airports = genSet(r); r.phase = "lobby"; r.cd = null; r.trivia = newTrivia(); // a new game: new questions
        for (const q of Object.values(r.players)) Object.assign(q, { ready: false, rounds: 0, total: 0, right: 0, streak: 0, done: false, viewing: !q.late, late: false, fin: null, log: null }); // viewing: they played, and are still on their results
      }
      if (p.action === "reset" || p.action === "ready") me.viewing = false; // this player is back in the lobby
      if (p.action === "config" && r.owner === p.id && r.phase !== "playing") { // the owner changes what will be played; a lobby's players are un-readied and get a fresh set
        const k = p.kind;
        if (["easy", "medium", "hard"].includes(k)) r.cfg = { kind: k, mode: k, fmt: "map", st: "" };
        else if (k === "custom" && ["map", "city"].includes(p.fmt) && (MODES.includes(p.mode) || p.mode === "all") && (p.st === "" || STATES.includes(p.st))) r.cfg = { kind: k, mode: p.mode, fmt: p.fmt, st: p.st, off: r.cfg.kind === "custom" && r.cfg.st === p.st ? r.cfg.off || [] : [] }; // switched-off airports are kept while the state stays the same
        else if (k === "list" && ["map", "city"].includes(p.fmt) && cleanList(p.list)) r.cfg = { kind: k, mode: "easy", fmt: p.fmt, st: "", list: cleanList(p.list) };
        else if (k === "zip" && zp) { r.cfg = { kind: k, mode: "easy", fmt: "map", st: "", zip: String(p.zip), miles: +p.miles, lat: zp.lat, lon: zp.lon, off: [] }; r.zp = zp; }
        else return json({ error: "That setting isn't available." }, 400);
        r.mode = r.cfg.mode === "all" ? "easy" : r.cfg.mode; r.act = now; // r.mode is the label the page and feedback use, so "all" counts as Normal there
        if (r.phase === "lobby") { r.airports = genSet(r); r.cd = null; for (const q of Object.values(r.players)) q.ready = false; }
      } else if (p.action === "config") return json({ error: "Only the lobby owner can change that." }, 403);
      if (p.action === "airport" || p.action === "airportAll") { // the host switches airports on or off (zip lobby: inside the radius; custom lobby with a state: the ones that difficulty can pick). An off airport is never picked.
        const c = r.cfg;
        if (r.owner !== p.id || r.phase === "playing") return json({ error: "Only the lobby owner can change that." }, 403);
        if (!(c.kind === "zip" || (c.kind === "custom" && c.st))) return json({ error: "There's no airport list to change right now." }, 400);
        const cand = c.kind === "custom" ? new Set(candidates(c.mode, c.st).map(x => x[0])) : null, inside = x => c.kind === "zip" ? dist(r.zp.lat, r.zp.lon, x[3], x[4]) <= c.miles : cand.has(x[0]);
        const off = new Set(c.off || []);
        if (p.action === "airportAll") { if (p.on) off.clear(); else for (const x of ALL.values()) if (inside(x)) off.add(x[0]); }
        else { const code = String(p.ap || "").toUpperCase(), a = ALL.get(code); if (!a || !inside(a)) return json({ error: "That airport isn't in the list." }, 400); if (p.on) off.delete(code); else off.add(code); }
        c.off = [...off]; r.act = now;
        if (r.phase === "lobby") { r.airports = genSet(r); r.cd = null; for (const q of Object.values(r.players)) q.ready = false; }
      }
      if (p.action === "ready" && p.value && !r.airports.length) return json({ error: "Switch at least one airport on." }, 400); // nothing to play
      if (p.action === "ready" && r.phase === "lobby") me.ready = !!p.value;
      if (p.action === "trivia" && r.phase === "lobby" && r.trivia && !me.late && Number.isInteger(p.q) && p.q >= 0 && p.q < TQ && Number.isInteger(p.choice) && p.choice >= 0 && p.choice < 4) {
        const mine = (r.trivia.ans[p.id] ||= Array(TQ).fill(null)); if (mine[p.q] == null) { mine[p.q] = p.choice; r.act = now; } // one answer per question, no changing it
      }
      if (p.action === "again" && r.phase === "lobby" && r.trivia && !me.late && p.tv === r.trivia.id && voteOpen(r, triviaPlayers(r))) { // a vote for new trivia (for the set the page is showing, so a slow press can't count toward the next one)
        if (p.value) r.trivia.again.add(p.id); else r.trivia.again.delete(p.id); r.act = now;
      }
      roomTick(r);
      json({ code, day: day(), mode: r.mode, cfg: r.cfg, empty: !r.airports.length, owner: r.owner === p.id, hn: r.games || 0, history: p.hn === (r.games || 0) ? undefined : r.history || [], phase: r.phase, cd: r.cd && r.phase === "lobby" ? Math.max(0, r.cd + CD_MS - now) : null, left: r.phase === "playing" ? Math.max(0, r.end - now) : null,
        closeIn: r.phase === "playing" ? null : Math.max(0, Math.min(IDLE_MS - (now - r.act), NOSTART_MS - (now - r.since))), // ms until this lobby times out (the page shows it next to the version)
        trivia: r.phase === "lobby" && !me.late ? triviaFor(r, p.id, typeof p.tv === "string" ? p.tv.slice(0, 16) : "") : undefined, airports: r.phase === "playing" && !me.late && p.ga !== (r.games || 0) ? r.airports : undefined, /* watchers never get the answers; a page that says (ga) it already has this game's airports isn't sent them again */ n: r.airports.length, players: Object.entries(r.players).map(([k, q]) => ({ fin: q.fin ?? null, name: q.name, ready: q.ready, rounds: q.rounds, total: q.total, right: q.right, streak: q.streak || 0, done: q.done, late: !!q.late, viewing: !!q.viewing, wins: q.wins || 0, me: k === p.id })) });
    }));
  }
  // Player feedback after a daily or friend game: one JSON object per line in feedback.jsonl (override the path with FEEDBACK_FILE), e.g.
  // {"t":"2026-11-22T10:00:00.000Z","kind":"daily","day":20779,"mode":"hard","rating":"meh","airports":["KABC"]}
  // rating = fun | meh | hard; airports = the ones the player said bothered them (empty for "fun"). Read it straight from the file,
  // or from GET /api/feedback (all lines as a JSON array; only from this computer, never through a tunnel or proxy).
  if (req.method === "POST" && u.pathname === "/api/feedback") {
    if (limited(req, "feedback", 20)) return json({ error: "Slow down a little." }, 429);
    let b = ""; req.on("data", c => (b += c, b.length > 1e3 && req.destroy()));
    return req.on("end", safe(res, () => {
      let p; try { p = JSON.parse(b); } catch { return json({ error: "bad json" }, 400); }
      if (!p || typeof p !== "object") return json({ error: "invalid" }, 400); // a body of "null" would throw below
      if (fs.existsSync(FEEDBACK) && fs.statSync(FEEDBACK).size > 5e6) return json({ error: "invalid" }, 503); // the file stops growing at 5 MB
      const ok = ["daily", "friend"].includes(p.kind) && Number.isInteger(p.day) && p.day >= 0 && p.day < 1e6 && MODES.includes(p.mode) && ["fun", "meh", "hard"].includes(p.rating)
        && Array.isArray(p.airports) && p.airports.length <= PER && p.airports.every(c => ALL.has(c));
      if (!ok) return json({ error: "invalid" }, 400);
      fs.appendFile(FEEDBACK, JSON.stringify({ t: new Date().toISOString(), kind: p.kind, day: p.day, mode: p.mode, rating: p.rating, airports: p.airports }) + "\n", () => {});
      json({ ok: true });
    }));
  }
  if (req.method === "GET" && u.pathname === "/api/feedback") {
    if (!isLocal(req)) return json({ error: "forbidden" }, 403);
    let rows = []; try { rows = fs.readFileSync(FEEDBACK, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch {}
    return json(rows);
  }
  // Share links: the page uploads its result picture (a PNG, 400 KB at most) and gets a short link, /s/<id>. That page carries Open Graph tags, which is what
  // makes Discord, X and others show a card (title, text and the score picture) when the link is pasted. People who open the link are sent to the game.
  // Files live in SHARES_DIR; only the newest 2000 are kept. The title is cleaned, the picture must really be a PNG, and each address gets 10 shares a minute.
  if (req.method === "POST" && u.pathname === "/api/share") {
    if (limited(req, "share", 10)) return json({ error: "Slow down a little." }, 429);
    let b = ""; req.on("data", c => (b += c, b.length > 6e5 && req.destroy()));
    return req.on("end", safe(res, () => {
      let p; try { p = JSON.parse(b); } catch { return json({ error: "bad json" }, 400); }
      if (!p || typeof p !== "object") return json({ error: "invalid" }, 400);
      const png = Buffer.from(String(p?.png || ""), "base64"), score = Math.floor(+p.score), of = Math.floor(+p.of);
      if (png.length < 100 || png.length > 4e5 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || !(score >= 0 && of > 0 && score <= of && of <= 99)) return json({ error: "invalid" }, 400);
      const title = [...String(p.title ?? "").replace(NAME_BAD, " ").replace(/\s+/g, " ").trim()].slice(0, 40).join("") || "Game", id = require("crypto").randomBytes(5).toString("hex");
      try {
        fs.mkdirSync(SHARES, { recursive: true });
        fs.writeFileSync(SHARES + "/" + id + ".png", png); fs.writeFileSync(SHARES + "/" + id + ".json", JSON.stringify({ title, score, of }));
        const old = fs.readdirSync(SHARES).filter(f => f.endsWith(".png")).map(f => [f, fs.statSync(SHARES + "/" + f).mtimeMs]).sort((x, y) => y[1] - x[1]).slice(2000);
        for (const [f] of old) { fs.rmSync(SHARES + "/" + f, { force: true }); fs.rmSync(SHARES + "/" + f.replace(".png", ".json"), { force: true }); }
      } catch { return json({ error: "Couldn't save that." }, 500); }
      json({ id });
    }));
  }
  const sh = req.method === "GET" && /^\/s\/([0-9a-f]{10})(\.png)?$/.exec(u.pathname);
  if (sh) {
    if (sh[2]) return serve(res, SHARES + "/" + sh[1] + ".png", "public, max-age=86400");
    let m; try { m = JSON.parse(fs.readFileSync(SHARES + "/" + sh[1] + ".json", "utf8")); } catch { res.writeHead(302, { location: "/" }); return res.end(); }
    const host = /^[\w.-]+(:\d+)?$/.test(req.headers.host || "") ? req.headers.host : "localhost", proto = req.headers["x-forwarded-proto"] === "https" || !/^(localhost|127\.)/.test(host) ? "https" : "http", base = proto + "://" + host,
      esc = t => String(t).replace(/[&<>"']/g, c => "&#" + c.charCodeAt(0) + ";"), ttl = "ICAOdle · " + m.title, desc = "I scored a " + m.score + "/" + m.of + ". Think you can beat it? Try your attempt!";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600", "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(ttl)}</title><meta http-equiv="refresh" content="0;url=/">
<meta property="og:type" content="website"><meta property="og:site_name" content="ICAOdle"><meta property="og:title" content="${esc(ttl)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${base}/s/${sh[1]}"><meta property="og:image" content="${base}/s/${sh[1]}.png"><meta property="og:image:width" content="1080"><meta property="og:image:height" content="1080">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(ttl)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${base}/s/${sh[1]}.png">
<meta name="theme-color" content="#ffb81c"></head><body><a href="/">Play ICAOdle</a></body></html>`);
  }
  // "Report incorrect info": players can flag a wrong study note. One JSON object per line in reports.jsonl (REPORTS_FILE), e.g.
  // {"t":"2026-11-23T10:00:00.000Z","kind":"study","code":"KCHS","text":"The ramp is on the west side"}
  // The text is cleaned (no control, invisible or direction-changing characters, no angle brackets, one line, 500 characters), the airport must be a real one,
  // the file stops growing at 5 MB, and each address gets 10 reports a minute. Read it from the file or from GET /api/reports (this computer only).
  if (req.method === "POST" && u.pathname === "/api/report") {
    if (limited(req, "report", 10)) return json({ error: "Slow down a little." }, 429);
    let b = ""; req.on("data", c => (b += c, b.length > 4e3 && req.destroy()));
    return req.on("end", safe(res, () => {
      let p; try { p = JSON.parse(b); } catch { return json({ error: "bad json" }, 400); }
      if (!p || typeof p !== "object") return json({ error: "invalid" }, 400);
      const text = [...String(p.text ?? "").replace(NAME_BAD, " ").replace(/\s+/g, " ").trim()].slice(0, 500).join(""), code = String(p.code || "").toUpperCase();
      if (text.length < 5) return json({ error: "Please write a little more." }, 400);
      if (code && !ALL.has(code)) return json({ error: "invalid" }, 400);
      try { if (fs.statSync(REPORTS).size > 5e6) return json({ error: "Reports are full for now. Thank you!" }, 503); } catch {}
      fs.appendFile(REPORTS, JSON.stringify({ t: new Date().toISOString(), kind: "study", code, text }) + "\n", () => {});
      json({ ok: true });
    }));
  }
  if (req.method === "GET" && u.pathname === "/api/reports") {
    if (!isLocal(req)) return json({ error: "forbidden" }, 403);
    let rows = []; try { rows = fs.readFileSync(REPORTS, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch {}
    return json(rows); // no CORS header: another website's script must not be able to read this
  }
  if (req.method === "POST" && u.pathname === "/api/reset") { // dev only: loopback clients can wipe all score stats
    if (!isLocal(req)) return json({ error: "forbidden" }, 403); // through the tunnel the client looks like loopback too, so the proxy headers must be checked here as well
    db.scores = {}; db.right = {}; save(); return json({ ok: true });
  }
  if (req.method === "POST" && u.pathname === "/api/score") {
    if (limited(req, "score", 30)) return json({ error: "Slow down a little." }, 429);
    let b = ""; req.on("data", c => (b += c, b.length > 1e3 && req.destroy()));
    return req.on("end", safe(res, () => {
      let p; try { p = JSON.parse(b); } catch { return json({ error: "bad json" }, 400); }
      if (!p || typeof p !== "object") return json({ error: "invalid" }, 400);
      const ok = Number.isInteger(p.score) && p.score >= 0 && p.score <= 20 && validId(p.id) && /^(easy|medium|hard)(-city)?$/.test(p.mode) && validDay(p.day) && (p.right === undefined || (Number.isInteger(p.right) && p.right >= 0 && p.right <= PER));
      if (!ok) return json({ error: "invalid" }, 400);
      const k = p.day + ":" + p.mode, d = (db.scores[k] ||= {});
      if (!(p.id in d) && Object.keys(d).length < 50000) { d[p.id] = p.score; if (p.right !== undefined) (db.right[k] ||= {})[p.id] = p.right; save(); } // first submission per player per day+mode wins; at most 50,000 players per day and mode, so the saved file and its rewrite stay small
      json(counts(k));
    }));
  }
  json({ error: "not found" }, 404);
}
// ponytail: JSON file + sync write, one process. Swap for SQLite/Redis if traffic outgrows it. Player id is client-generated, so not cheat-proof; answers are sent to the client.
