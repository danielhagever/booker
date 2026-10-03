// Round 4: demographics for many artists in one call; popularity of known acts by room size; trends bias.
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
const find = async (n) => ents((await get("/search", { query: n, types: "urn:entity:artist", take: "3" })).b).find((e) => e.name.toLowerCase() === n.toLowerCase());
// Popularity by rough room size (my own knowledge of typical rooms, only to see the spread)
const groups = { "club 100-300": ["Dirt Buyer", "Sour Widows", "Fake Fruit", "Pool Holograph"], "club 300-800": ["Wednesday", "Hovvdy", "Horse Jumper of Love", "Slow Pulp"], "theater 1500+": ["Snail Mail", "Japanese Breakfast", "Alex G", "Big Thief"] };
const ids = [];
for (const [g, names] of Object.entries(groups)) {
  const out = [];
  for (const n of names) { const e = await find(n); if (e) { out.push(`${n} p${(+e.popularity).toFixed(3)}`); ids.push(e.entity_id); } else out.push(`${n} ?`); }
  console.log(g, "|", out.join(" | "));
}
const d = await get("/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": ids.slice(0, 6).join(",") });
console.log("\n## demographics for 6 artists in one call", d.s, "rows:", (d.b?.results?.demographics ?? []).length, JSON.stringify(d.b?.results?.demographics?.[1]?.query ?? d.b).slice(0, 200));
const t = await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": ids.slice(4, 8).join(","), "filter.popularity.max": "0.7", "bias.trends": "high", take: "8" });
console.log("\n## bias.trends=high", t.s, ents(t.b).map((e) => `${e.name} p${(+e.popularity).toFixed(2)}`).join(" | "), t.s !== 200 ? JSON.stringify(t.b).slice(0, 200) : "");
