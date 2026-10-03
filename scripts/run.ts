// Runs Booker's pipelines in Node against the live Qloo API (key from .dev.vars), for development.
// Usage: node scripts/run.ts venue "The Empty Bottle, Chicago" "Wednesday,Hovvdy,Snail Mail" ["pitch1,pitch2"] [rising]
//        node scripts/run.ts artist "Wednesday" "Chicago, Illinois;Austin, Texas"
import { readFileSync } from "node:fs";
import { forArtist, forVenue } from "../src/booker.ts";
import { Budget, REQUEST_BUDGET } from "../src/limits.ts";
import { names, cityList } from "../src/input.ts";
import { memoryKV } from "../test/mock.ts";
import { tourSummary, venueSummary } from "../src/index.ts";
const KEY = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/QLOO_API_KEY\s*=\s*"?([^"\n]+)/)![1];
const env = { QLOO_API_KEY: KEY, QLOO_BASE_URL: "https://hackathon.api.qloo.com", CACHE: memoryKV().kv };
const [mode, a, b, c, d] = process.argv.slice(2);
const budget = new Budget(REQUEST_BUDGET);
const t = Date.now();
const r: any = mode === "venue"
  ? await forVenue(env, budget, { venue: { name: a }, acts: names(b, 8).list, pitches: names(c ?? "", 8).list, rising: d === "rising" })
  : await forArtist(env, budget, { artist: { name: a }, cities: cityList(b).list });
console.log(mode === "venue" ? venueSummary(r) : tourSummary(r));
console.log(`\n${((Date.now() - t) / 1000).toFixed(1)} s, ${r.calls.length} Qloo calls, budget used ${budget.used}, statuses ${r.calls.map((x: any) => x.status).join("")}, degraded ${r.degraded}`);
for (const s of r.trace) console.log(" T", s.step + ":", s.detail);
if (mode === "venue") {
  console.log(" venue:", r.venue.name, r.venue.match, r.venue.city, "| acts:", r.acts.map((x: any) => `${x.name}(${x.match},p${x.popularity?.toFixed(2)})`).join(", "));
  console.log(" FITS:", r.fits.map((x: any) => `${x.name} p${x.popularity?.toFixed(2)} a${x.affinity?.toFixed(3)} ~${x.closest?.name ?? "-"} [${(x.genres ?? []).join("/")}]`).join(" | "));
  console.log(" OPENERS:", r.openers.map((x: any) => `${x.name} p${x.popularity?.toFixed(2)} a${x.affinity?.toFixed(3)} ~${x.closest?.name ?? "-"}`).join(" | "));
  console.log(" BILLS:", r.bills.map((x: any) => `${x.headliner} + ${x.opener} (${x.overlap.toFixed(3)})`).join(" | "));
  console.log(" INBOX:", r.inbox.map((x: any) => `${x.name}: ${x.verdict} (${x.why})`).join(" | "));
  console.log(" ROOM FANS:", r.roomFans.map((x: any) => x.name).join(", "));
  console.log(" RIVALS for", r.rivals.act + ":", r.rivals.rooms.map((x: any) => `${x.name}${x.you ? "*" : ""} ${x.affinity?.toFixed(3)}`).join(" | "));
} else {
  for (const x of r.cities) console.log(" CITY", x.label, x.affinity?.toFixed(3), "| qloo:", x.qlooCity, "| rooms:", x.rooms.map((y: any) => `${y.name} ${y.affinity?.toFixed(3)}`).join(" ; "));
  console.log(" not found:", r.notFound);
}
