// Round 5: response shapes Booker relies on (venue geocode, artist tags), and a city query failure.
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
const v = ents((await get("/search", { query: "The Empty Bottle Chicago", types: "urn:entity:place", take: "1" })).b)[0];
console.log("venue keys:", Object.keys(v).join(","), "\nproperties keys:", Object.keys(v.properties ?? {}).join(","), "\ngeocode:", JSON.stringify(v.properties?.geocode ?? v.geocode ?? null), "\nlocation:", JSON.stringify(v.location));
const x = await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.location.query": "Chicago", take: "6" });
for (const e of ents(x.b)) console.log("artist:", e.name, "| tag types:", [...new Set((e.tags ?? []).map((t) => t.type))].join(","), "| genres:", (e.tags ?? []).filter((t) => /genre/.test(t.type ?? t.id)).map((t) => t.name).slice(0, 4).join("/"), "| props:", Object.keys(e.properties ?? {}).slice(0, 8).join(","));
const bad = await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.location.query": "Zzqxville", take: "3" });
console.log("\nunknown city:", bad.s, JSON.stringify(bad.b).slice(0, 200));
