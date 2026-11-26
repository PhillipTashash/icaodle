// One-off: makes states.json, the lower-48 state borders (and coastline) the round maps draw under the airport dots. Run `node build-states.js` to rebuild it.
// Source: us-atlas (US Census Bureau cartographic boundaries, public domain), states at 1:10m. Each shared border is kept once, simplified, in [lon, lat].
const fs = require("fs");
const SKIP = new Set(["02", "15", "60", "66", "69", "72", "78"]); // Alaska, Hawaii and the territories: off the lower-48 map
const TOL = 0.03; // degrees: detail finer than this (about 3 km) is dropped

// Ramer-Douglas-Peucker: keep only the points that bend the line by more than TOL
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
  const used = new Set(), walk = v => Array.isArray(v) ? v.forEach(walk) : used.add(v < 0 ? ~v : v);
  for (const g of topo.objects.states.geometries) if (!SKIP.has(g.id)) walk(g.arcs);
  const lines = [...used].sort((a, b) => a - b).map(i => simplify(arcs[i]).map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)])).filter(l => l.length > 1);
  fs.writeFileSync("states.json", JSON.stringify(lines));
  console.log(lines.length + " lines, " + lines.reduce((n, l) => n + l.length, 0) + " points, " + Math.round(fs.statSync("states.json").size / 1024) + " KB");
})();
