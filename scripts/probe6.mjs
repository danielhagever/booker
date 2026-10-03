// Round 6: entity by id, concert-hall tag, "City, Region" location queries.
import { readFileSync } from "node:fs";
const KEY = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/QLOO_API_KEY\s*=\s*"?([^"\n]+)/)[1];
const BASE = "https://hackathon.api.qloo.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, params) {
  await sleep(450);
  const r = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, { headers: { "X-Api-Key": KEY } });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t.slice(0, 200); }
  return { s: r.status, b };
}
const ents = (b) => b?.results?.entities ?? (Array.isArray(b?.results) ? b.results : []);
const id = "8B041C04"; // Empty Bottle prefix; get the full id first
const v = ents((await get("/search", { query: "The Empty Bottle Chicago", types: "urn:entity:place", take: "1" })).b)[0];
for (const [p, q] of [["/entities", { entity_ids: v.entity_id }], ["/v2/entities", { entity_ids: v.entity_id }]]) {
  const x = await get(p, q);
  console.log("by id", p, x.s, x.s === 200 ? ents(x.b).map((e) => `${e.name} | ${e.properties?.geocode?.city}`).join(" ; ") : JSON.stringify(x.b).slice(0, 150));
}
const t = await get("/v2/tags", { "filter.query": "concert hall", "feature.semantic_search": "true", take: "6" });
console.log("concert hall tags:", (t.b?.results?.tags ?? []).map((x) => x.id).join("  "));
const art = ents((await get("/search", { query: "Wednesday", types: "urn:entity:artist", take: "1" })).b)[0];
for (const city of ["Chicago, Illinois", "Austin, Texas", "London, United Kingdom", "Portland, Maine", "New York, New York", "Berlin, Germany"]) {
  const x = await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.location.query": city, "filter.results.entities": art.entity_id, take: "1" });
  const l = x.b?.query?.localities?.signal;
  console.log(`resonance of ${art.name} in ${city}: [${x.s}]`, ents(x.b).map((e) => (+e.query?.affinity).toFixed(3)).join(","), "| locality:", l ? `${l.name} (${l.location?.lat?.toFixed(2)},${l.location?.lon?.toFixed(2)})` : JSON.stringify(x.b).slice(0, 120));
}
