// node build-landmarks.js — finds one famous landmark near each airport (Wikidata: most-linked attraction within 40 km, airports excluded)
// and caches it in landmarks.json {ICAO: "Name"}. Resumable: re-run to fill gaps. ~2s per airport; the server reads the file at startup.
const fs = require("fs"), FILE = "landmarks.json", AIR = Object.values(JSON.parse(fs.readFileSync("airports.json"))).flat();
let cache = {}; try { cache = JSON.parse(fs.readFileSync(FILE)); } catch {}
const query = (lat, lon) => `SELECT ?itemLabel ?sl WHERE { SERVICE wikibase:around { ?item wdt:P625 ?loc . bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "40" . }
  ?item wikibase:sitelinks ?sl . FILTER(?sl>=8)
  VALUES ?cls { wd:Q570116 wd:Q33506 wd:Q22698 wd:Q483110 wd:Q12280 wd:Q11303 wd:Q23413 wd:Q16560 wd:Q4989906 wd:Q1081138 wd:Q2065736 wd:Q811979 } ?item wdt:P31/wdt:P279* ?cls .
  FILTER NOT EXISTS { ?item wdt:P31/wdt:P279* wd:Q1248784 }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" } } ORDER BY DESC(?sl) LIMIT 5`;
async function lookup(a, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query(a[3], a[4])), { headers: { "User-Agent": "icaodle-build/1.0 (landmark lookup)", Accept: "application/sparql-results+json" } });
      if (r.ok) { const b = (await r.json()).results.bindings.find(x => !/^Q\d+$/.test(x.itemLabel.value)); return b ? b.itemLabel.value : ""; } // "" = none found (cached so we don't retry)
    } catch {}
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  return undefined;
}
(async () => {
  const todo = AIR.filter(a => !(a[0] in cache)); let done = 0, i = 0;
  await Promise.all([0, 1].map(async () => { // 2 at a time, be polite to the public endpoint
    while (i < todo.length) {
      const a = todo[i++], v = await lookup(a);
      if (v !== undefined) cache[a[0]] = v;
      if (++done % 25 === 0) { fs.writeFileSync(FILE, JSON.stringify(cache)); console.log(done + "/" + todo.length); }
    }
  }));
  fs.writeFileSync(FILE, JSON.stringify(cache));
  console.log("done:", Object.values(cache).filter(Boolean).length, "with a landmark of", Object.keys(cache).length);
})();
