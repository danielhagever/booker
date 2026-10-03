// Booker feasibility probes against the hackathon API. Prints names and numbers only, never the key.
import { readFileSync } from "node:fs";
const KEY = readFileSync(new URL("../../newcomer/.dev.vars", import.meta.url), "utf8").match(/QLOO_API_KEY\s*=\s*"?([^"\n]+)/)[1];
const BASE = "https://hackathon.api.qloo.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, params) {
  await sleep(450);
  const r = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, { headers: { "X-Api-Key": KEY } });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t.slice(0, 200); }
  return { s: r.status, b };
}
const ents = (b) => b?.results?.entities ?? (Array.isArray(b?.results) ? b.results : []);
const show = (label, x) => console.log(`\n## ${label} [${x.s}]`, x.s !== 200 ? JSON.stringify(x.b).slice(0, 300) : "");
const brief = (e) => `${e.name}${e.popularity !== undefined ? ` pop=${(+e.popularity).toFixed(3)}` : ""}${e.query?.affinity !== undefined ? ` aff=${(+e.query.affinity).toFixed(3)}` : ""}`;

// 1. Venues as Qloo places
const venues = {};
for (const q of ["Mohawk Austin", "Empty Bottle Chicago", "Bowery Ballroom", "The Echo Los Angeles", "Barboza Seattle"]) {
  const x = await get("/search", { query: q, types: "urn:entity:place", take: "3" });
  show(`search place: ${q}`, x);
  for (const e of ents(x.b)) console.log("  ", e.name, "|", e.disambiguation ?? e.properties?.address ?? "", "|", (e.tags ?? []).filter((t) => /category/.test(t.type ?? "")).map((t) => t.name).join("/"), "| id", e.entity_id?.slice(0, 8));
  venues[q] = ents(x.b)[0];
}
// 2. Artists liked by people who like the venue
for (const q of ["Mohawk Austin", "Empty Bottle Chicago"]) {
  const v = venues[q]; if (!v) continue;
  const x = await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": v.entity_id, take: "10" });
  show(`artists for fans of venue ${v.name}`, x);
  console.log("  ", ents(x.b).map(brief).join(" | "));
}
// 3. Location signal for artists: does the list change by place?
for (const loc of ["East Austin", "Williamsburg, Brooklyn", "Nashville"]) {
  const x = await get("/v2/insights", { "filter.type": "urn:entity:artist", "signal.location.query": loc, take: "8" });
  show(`artists, signal.location.query=${loc}`, x);
  console.log("  ", ents(x.b).map(brief).join(" | "), "| query:", JSON.stringify(x.b?.query ?? {}).slice(0, 200));
}
