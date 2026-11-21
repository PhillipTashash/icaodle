// node build-airports.js — regenerates airports.json from OurAirports (public domain).
const URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
// Minimal CSV parser (handles quoted fields with commas and "" escapes).
function parse(t) {
  const rows = []; let r = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') t[i + 1] === '"' ? (f += '"', i++) : (q = false); else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") (r.push(f), f = "");
    else if (c === "\n") (r.push(f), rows.push(r), r = [], f = "");
    else if (c !== "\r") f += c;
  }
  return rows;
}
(async () => {
  const [h, ...rows] = parse(await (await fetch(URL)).text()), i = n => h.indexOf(n);
  const out = { easy: [], medium: [], hard: [] };
  for (const r of rows) {
    if (!/^K[A-Z]{3}$/.test(r[i("ident")]) || r[i("iso_country")] !== "US" || !r[i("municipality")]) continue;
    const type = r[i("type")], sched = r[i("scheduled_service")] === "yes", iata = !!r[i("iata_code")];
    // easy: big airports. medium: other airports with airline service (places a lay-person has flown). hard: airports with an IATA code but no airline service. No-code private strips are left out.
    const tier = type === "large_airport" ? "easy" : sched && (type === "medium_airport" || type === "small_airport") ? "medium" : iata && (type === "medium_airport" || type === "small_airport") ? "hard" : null;
    // [icao, city, state, lat, lon, zoom, name, elevation_ft] — zoom by size; tune per airport if a boundary is cut off.
    if (tier) out[tier].push([r[i("ident")], r[i("municipality")], r[i("iso_region")].slice(3), +r[i("latitude_deg")], +r[i("longitude_deg")], { easy: 14, medium: 15, hard: 16 }[tier], r[i("name")], Math.round(+r[i("elevation_ft")] || 0)]);
  }
  require("fs").writeFileSync("airports.json", JSON.stringify(out));
  console.log(Object.entries(out).map(([k, v]) => k + ":" + v.length).join(" "), "KFTW in:", Object.keys(out).filter(k => out[k].some(a => a[0] === "KFTW")));
})();
