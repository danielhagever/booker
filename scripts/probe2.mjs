// Booker probes, round 2: city-level location signal, past acts as signal, popularity band, scoring a given list, demographics.
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
const brief = (e) => `${e.name} p${(+e.popularity).toFixed(2)} a${(+e.query?.affinity).toFixed(3)}`;
const say = (label, x, extra = "") => console.log(`\n## ${label} [${x.s}] ${x.s !== 200 ? JSON.stringify(x.b).slice(0, 250) : ""}\n   ${ents(x.b).map(brief).join(" | ")} ${extra}`);
const id = async (name) => ents((await get("/search", { query: name, types: "urn:entity:artist", take: "3" })).b).find((e) => e.name.toLowerCase() === name.toLowerCase())?.entity_id;

// Past acts for an indie rock club (Empty Bottle-style)
const past = [];
for (const n of ["Wednesday", "Horse Jumper of Love", "Hovvdy", "Snail Mail"]) { const i = await id(n); console.log("resolved", n, i?.slice(0, 8)); if (i) past.push(i); }
const P = past.join(",");
say("A. similar to past acts (no limits)", await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": P, take: "10" }));
say("B. similar + popularity.max 0.6", await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": P, "filter.popularity.max": "0.6", take: "10" }));
say("C. similar + pop.max 0.6 + signal.location.query=Chicago", await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": P, "filter.popularity.max": "0.6", "signal.location.query": "Chicago", take: "10" }));
say("D. similar + pop.max 0.6 + signal.location.query=Austin", await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": P, "filter.popularity.max": "0.6", "signal.location.query": "Austin", take: "10" }));
say("E. location only: Chicago", await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.location.query": "Chicago", take: "6" }));
say("F. location only: Austin", await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.location.query": "Austin", take: "6" }));
// G. Score a given list (a booker's inbox) against the venue's past acts
const inbox = [];
for (const n of ["Alex G", "Japanese Breakfast", "Turnpike Troubadours", "Skrillex"]) { const i = await id(n); if (i) inbox.push(i); }
say("G. inbox scored vs past acts (filter.results.entities)", await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": P, "filter.results.entities": inbox.join(","), take: "10" }));
// H. Demographics of fans of one artist
const demo = await get("/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": past[0] });
console.log("\n## H. demographics", demo.s, JSON.stringify(demo.b?.results ?? demo.b).slice(0, 600));
