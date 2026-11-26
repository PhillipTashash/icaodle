// One-off: makes state-shapes.json, each lower-48 state's (plus DC's) own full outline, for the 1v1 duel's locator map (state highlight). Run `node
// build-state-shapes.js` to rebuild it. Unlike states.json (shared borders, each kept once, for a plain backdrop), this keeps every state's complete,
// closed ring(s) so any single one can be filled in on its own. Source: us-atlas (US Census Bureau cartographic boundaries, public domain), states at 1:10m.
const fs = require("fs");
const SKIP = new Set(["02", "15", "60", "66", "69", "72", "78"]); // Alaska, Hawaii and the territories: duel only draws the airports a[2] can name, all lower-48 + DC
const FIPS = { "01": "AL", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY" };
const TOL = 0.03; // degrees: detail finer than this (about 3 km) is dropped, same as states.json

function simplify(pts) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(), [x1, y1] = pts[a], [x2, y2] = pts[b], dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-9;
    let far = -1, idx = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len; if (d > far) { far = d; idx = i; } }
    if (far > TOL) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

(async () => {
  const topo = await (await fetch("https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json")).json();
  const t = topo.transform, arcs = topo.arcs.map(a => { let x = 0, y = 0; return a.map(([dx, dy]) => [(x += dx) * t.scale[0] + t.translate[0], (y += dy) * t.scale[1] + t.translate[1]]); });
  // A ring is a cycle of (possibly reversed, ~i) arc indices whose points already share endpoints; concatenating them (dropping each arc's repeated first point) closes it.
  const ring = idxs => { const pts = []; for (const i of idxs) { const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i]; pts.push(...(pts.length ? a.slice(1) : a)); } return pts; };
  const out = {};
  for (const g of topo.objects.states.geometries) {
    if (SKIP.has(g.id)) continue;
    const code = FIPS[g.id]; if (!code) continue;
    // Polygon: arcs = [ring, ...]; MultiPolygon: arcs = [[ring, ...], [ring, ...]] (one state can be several landmasses, e.g. Michigan). No US state has a hole.
    const rings = g.type === "MultiPolygon" ? g.arcs.flatMap(poly => poly.map(ring)) : g.arcs.map(ring);
    // Each ring closes on itself (first point === last), which breaks plain RDP (its baseline is a zero-length segment): drop the repeated closing
    // point, simplify the open curve that's left, then put it back.
    out[code] = rings.map(r => { const s = simplify(r.slice(0, -1)); return [...s, s[0]].map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]); }).filter(r => r.length > 3);
  }
  fs.writeFileSync("state-shapes.json", JSON.stringify(out));
  const n = Object.keys(out).length, pts = Object.values(out).reduce((s, rs) => s + rs.reduce((a, r) => a + r.length, 0), 0);
  console.log(n + " states, " + pts + " points, " + Math.round(fs.statSync("state-shapes.json").size / 1024) + " KB");
})();
