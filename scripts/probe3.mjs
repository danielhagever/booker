// Booker probes, round 3: venues that fit an artist (reverse mode); the live-music-venue tag; local fit via heatmap.
import { readFileSync } from "node:fs";
const KEY = readFileSync(new URL("../../newcomer/.dev.vars", import.meta.url), "utf8").match(/QLOO_API_KEY\s*=\s*"?([^"\n]+)/)[1];
const BASE = "https://hackathon.api.qloo.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, params) {
  await sleep(450);
  const r = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, { headers: { "X-Api-Key": KEY } });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t.slice(0, 200); }
  return { s: r.status, b };
}
const ents = (b) => b?.results?.entities ?? (Array.isArray(b?.results) ? b.results : []);
// The tag for live music venues
const tags = await get("/v2/tags", { "filter.query": "live music venue", "feature.semantic_search": "true", take: "10" });
console.log("## tags", tags.s, (tags.b?.results?.tags ?? []).map((t) => `${t.name}=${t.id}[${(t.parents ?? []).map((p) => (p.type ?? p).replace("urn:entity:", "")).join("/")}]`).join("  "));
const venueTag = (tags.b?.results?.tags ?? []).find((t) => /category:place/.test(t.id) && /live music venue/i.test(t.name))?.id;
console.log("venue tag:", venueTag);
const art = ents((await get("/search", { query: "Wednesday", types: "urn:entity:artist", take: "3" })).b)[0];
const art2 = ents((await get("/search", { query: "Charley Crockett", types: "urn:entity:artist", take: "3" })).b)[0];
for (const [a, city] of [[art, "Chicago"], [art, "Austin"], [art2, "Austin"]]) {
  const x = await get("/v2/insights", { "filter.type": "urn:entity:place", "filter.tags": venueTag, "filter.location.query": city, "signal.interests.entities": a.entity_id, take: "8" });
  console.log(`\n## venues in ${city} for fans of ${a.name} [${x.s}] ${x.s !== 200 ? JSON.stringify(x.b).slice(0, 200) : ""}`);
  console.log("  ", ents(x.b).map((e) => `${e.name} a${(+e.query?.affinity).toFixed(3)} p${(+e.popularity).toFixed(2)}`).join(" | "));
}
// Local fit: heatmap of an artist's fans in Chicago; percentile of the cell at the Empty Bottle (41.9005,-87.6866)
const h = await get("/v2/insights", { "filter.type": "urn:heatmap", "filter.location.query": "Chicago", "signal.interests.entities": art.entity_id });
const cells = h.b?.results?.heatmap ?? [];
const at = { lat: 41.9005, lon: -87.6866 };
const d = (c) => Math.hypot(c.location.latitude - at.lat, (c.location.longitude - at.lon) * Math.cos(at.lat * Math.PI / 180));
const near = [...cells].sort((a, b) => d(a) - d(b)).slice(0, 5);
console.log(`\n## heatmap Chicago for ${art.name} [${h.s}] cells=${cells.length} bytes=${JSON.stringify(h.b).length}; cells nearest the Empty Bottle:`, near.map((c) => `${(d(c) * 111).toFixed(2)}km p${(+c.query.affinity).toFixed(2)}`).join(" | "));
