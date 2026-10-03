// Round 7: popularity limits with 4 decimals (Booker sends its size range rounded outward to 4).
import { readFileSync } from "node:fs";
const KEY = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/QLOO_API_KEY\s*=\s*"?([^"\n]+)/)[1];
const BASE = "https://hackathon.api.qloo.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, params) {
  await sleep(450);
  const r = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, { headers: { "X-Api-Key": KEY } });
  return { s: r.status, b: await r.json().catch(() => null) };
}
const ents = (b) => b?.results?.entities ?? (Array.isArray(b?.results) ? b.results : []);
const art = ents((await get("/search", { query: "Wednesday", types: "urn:entity:artist", take: "1" })).b)[0];
for (const [min, max] of [["0.9500", "0.9620"], ["0.9551", "0.9559"], ["0.950", "0.962"]]) {
  const x = await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": art.entity_id, "filter.popularity.min": min, "filter.popularity.max": max, take: "25" });
  const pops = ents(x.b).map((e) => e.popularity);
  console.log(`min ${min} max ${max}: [${x.s}] ${pops.length} results, popularity ${pops.length ? `${Math.min(...pops).toFixed(5)} to ${Math.max(...pops).toFixed(5)}` : "-"}, all inside: ${pops.every((p) => p >= +min && p <= +max)}`);
}
