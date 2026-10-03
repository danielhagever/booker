// Booker's pipelines against a mock Qloo shaped like the live API. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { forArtist, forVenue, sizeOf, fromSize, cityOf } from "../src/booker.ts";
import { resembles, nameKey, isRoom } from "../src/resolve.ts";
import { names, cityList } from "../src/input.ts";
import { Budget } from "../src/limits.ts";
import { ENV, UUID, artist, memoryKV, mockFetch, venue, type Call } from "./mock.ts";

const qloo = (c: Call) => c.host === "qloo.test";
const insights = (c: Call, type: string) => qloo(c) && c.path === "/v2/insights" && c.params.get("filter.type") === type;

// The acts that did well at the room, and the artists Qloo knows.
const PAST = [artist(10, "Wednesday", 0.955), artist(11, "Hovvdy", 0.897), artist(12, "Horse Jumper of Love", 0.941), artist(13, "Snail Mail", 0.983)];
const CATALOG = [
  ...PAST,
  artist(20, "Soccer Mommy", 0.98),
  artist(21, "Slow Pulp", 0.972),
  artist(22, "Dehd", 0.937),
  artist(23, "Alex G", 0.99),
  artist(24, "Dirt Buyer", 0.54),
  artist(25, "Jodi", 0.58),
  artist(26, "Turnpike Troubadours", 0.94, ["Country"]),
  artist(27, "Skrillex", 0.999, ["Dubstep"]),
  artist(28, "Anna Burch", 0.85),
  artist(29, "Big Thief", 0.991),
];
// Taste: how much fans of the indie acts like each artist (Qloo affinity), as measured for real acts.
const TASTE: Record<string, number> = {
  "Soccer Mommy": 0.984, "Slow Pulp": 0.983, Dehd: 0.95, "Alex G": 0.98, "Dirt Buyer": 0.954, Jodi: 0.966,
  "Turnpike Troubadours": 0.806, Skrillex: 0.651, "Anna Burch": 0.969, "Big Thief": 0.982,
  Wednesday: 0.99, Hovvdy: 0.99, "Horse Jumper of Love": 0.99, "Snail Mail": 0.99,
};
const ROOMS = [venue(1, "The Empty Bottle", "Chicago", "Illinois"), venue(2, "Bottled Blonde", "Chicago", "Illinois", ["Restaurant", "Sports bar"]), venue(3, "Empty Bottle Records", "Chicago", "Illinois", ["Record store"])];

function standardQloo(opts: { unknownCity?: boolean } = {}) {
  return (c: Call) => {
    if (!qloo(c)) return undefined;
    if (c.path === "/search") {
      const q = (c.params.get("query") ?? "").toLowerCase();
      if (c.params.get("types") === "urn:entity:place") return { body: { results: ROOMS.filter((r) => q.split(/\s+/).some((w) => w.length > 2 && r.name.toLowerCase().includes(w))) } };
      if (q === "twins") return { body: { results: [artist(40, "Twins", 0.9), artist(41, "Twins", 0.5, ["Metal"])] } };
      if (q === "snail male") return { body: { results: [artist(13, "Snail Mail", 0.983), artist(42, "Kurt Vile", 0.9)] } };
      return { body: { results: CATALOG.filter((a) => a.name.toLowerCase() === q) } };
    }
    if (c.path === "/entities") {
      const ids = (c.params.get("entity_ids") ?? "").split(",");
      return { body: { results: [...CATALOG, ...ROOMS, artist(41, "Twins", 0.5, ["Metal"])].filter((e) => ids.includes(e.entity_id)) } };
    }
    if (insights(c, "urn:entity:artist")) {
      const city = c.params.get("signal.location.query");
      if (city && (opts.unknownCity || /zzq/i.test(city))) return { status: 400, body: { errors: [{ message: "signal.location.query is unable to resolve to a valid locality.", path: "signal.location" }] } };
      const min = Number(c.params.get("filter.popularity.min") ?? 0), max = Number(c.params.get("filter.popularity.max") ?? 1);
      const only = c.params.get("filter.results.entities")?.split(",");
      const exclude = c.params.get("filter.exclude.entities")?.split(",") ?? [];
      const signals = c.params.get("signal.interests.entities")?.split(",") ?? [];
      let list = CATALOG.filter((a) => a.popularity >= min && a.popularity <= max && !exclude.includes(a.entity_id) && (!only || only.includes(a.entity_id)));
      // Measured: with the city as a signal, Qloo leaves some off-taste artists out of a scored list.
      if (city && only) list = list.filter((a) => (TASTE[a.name] ?? 0) > 0.9);
      // A recommendation list (no given list) holds artists the signals' fans like, as Qloo's does.
      if (!only && signals.length) list = list.filter((a) => (TASTE[a.name] ?? 0) > 0.9);
      const local = city ? 0.002 : 0;
      const aff = (a: any) => (signals.length === 1 && signals[0] === a.entity_id ? 1 : (TASTE[a.name] ?? 0.7) + local - (signals.length === 1 ? 0.01 * (a.entity_id.charCodeAt(35) % 3) : 0));
      const ranked = list.map((a) => ({ ...a, query: { affinity: Math.min(1, aff(a)) } })).sort((x, y) => y.query.affinity - x.query.affinity).slice(0, Number(c.params.get("take") ?? 10));
      return { body: { success: true, results: { entities: ranked }, ...(city ? { query: { localities: { signal: { name: city.split(",")[0], location: city.startsWith("Asheville") ? { lat: 35.6, lon: -82.55 } : city.startsWith("Austin") ? { lat: 30.3, lon: -97.75 } : { lat: 41.84, lon: -87.69 } } } } } : {}) } };
    }
    if (insights(c, "urn:entity:place")) {
      const city = c.params.get("filter.location.query") ?? "";
      if (!c.params.get("filter.tags")?.includes("live_music_venue")) return { body: { results: { entities: [] } } };
      return { body: { results: { entities: [venue(5, "Thalia Hall", "Chicago", "Illinois", undefined, 0.966), venue(1, "The Empty Bottle", "Chicago", "Illinois", undefined, 0.958), venue(6, `Room in ${city.split(",")[0]}`, city.split(",")[0], "X", undefined, 0.9)] } } };
    }
    return undefined;
  };
}

const run = (input: Partial<Parameters<typeof forVenue>[2]> = {}, opts?: { unknownCity?: boolean }) => {
  const m = mockFetch(standardQloo(opts));
  return forVenue(ENV(memoryKV().kv), new Budget(48), {
    venue: { name: "Empty Bottle, Chicago" },
    acts: PAST.map((a) => ({ name: a.name })),
    pitches: [],
    rising: false,
    ...input,
  }).finally(() => m.restore()).then((r) => ({ r, calls: m.calls }));
};

test("size is measured on a log scale: 0.98 and 0.99 are clubs and theaters apart", () => {
  assert.ok(Math.abs(sizeOf(0.99) - 2) < 1e-9 && Math.abs(sizeOf(0.9) - 1) < 1e-9);
  assert.ok(Math.abs(fromSize(sizeOf(0.537)) - 0.537) < 1e-9);
  // The band from acts at 0.897-0.983, widened by 0.1 on that scale, stops short of a 0.99 theater act.
  assert.ok(fromSize(sizeOf(0.983) + 0.1) < 0.99);
});

test("acts that fit: liked by the fans of your acts, in your city, at your size, without your own acts", async () => {
  const { r, calls } = await run();
  const fit = calls.find((c) => c.path === "/v2/insights" && c.params.get("filter.popularity.min") && !c.params.get("filter.results.entities"))!;
  assert.equal(fit.params.get("signal.location.query"), "Chicago, Illinois");
  assert.equal(fit.params.get("signal.interests.entities"), PAST.map((a) => a.entity_id).join(","));
  assert.equal(fit.params.get("filter.exclude.entities"), PAST.map((a) => a.entity_id).join(","));
  const names = r.fits.map((f) => f.name);
  assert.ok(names.includes("Soccer Mommy") && names.includes("Dehd"));
  assert.ok(!names.includes("Alex G") && !names.includes("Big Thief"), "theater-sized acts are not a club's fit");
  assert.ok(!names.includes("Wednesday"), "your own acts aren't suggested back");
  assert.ok(r.openers.some((o) => o.name === "Dirt Buyer") && r.openers.every((o) => (o.popularity ?? 0) <= fromSize(sizeOf(0.897) - 0.1)));
  assert.equal(r.qlooCity, "Chicago");
});

test("the inbox: fits, opener, bigger and off-taste, scored without the city next to Qloo's own picks", async () => {
  const { r, calls } = await run({ pitches: ["Dehd", "Dirt Buyer", "Alex G", "Turnpike Troubadours", "Skrillex"].map((name) => ({ name })) });
  const scoring = calls.filter((c) => c.params.get("filter.results.entities")?.includes(UUID(26)));
  assert.equal(scoring.length, 1);
  assert.equal(scoring[0].params.get("signal.location.query"), null, "the city would drop off-taste artists from the score");
  const v = Object.fromEntries(r.inbox.map((p) => [p.name, p.verdict]));
  assert.deepEqual(v, { Dehd: "fits", "Dirt Buyer": "smaller", "Alex G": "bigger", "Turnpike Troubadours": "off-taste", Skrillex: "off-taste" });
  assert.equal(r.inbox[0].name, "Dehd", "fits come first");
});

test("an unknown city doesn't fail the search: asked again without it, and the trace says so", async () => {
  const { r } = await run({}, { unknownCity: true });
  assert.ok(r.fits.length > 0);
  assert.equal(r.city, undefined);
  assert.ok(r.trace.some((t) => t.step === "City" && /couldn't place/.test(t.detail)));
});

test("bills pair each top act with the opener whose fans overlap most, each opener once", async () => {
  const { r } = await run();
  assert.ok(r.bills.length >= 1);
  const openers = r.bills.map((b) => b.opener);
  assert.equal(new Set(openers).size, openers.length);
  assert.ok(r.bills.every((b) => r.fits.some((f) => f.name === b.headliner) && r.openers.some((o) => o.name === b.opener)));
});

test("every candidate names the act of yours whose fans like it most", async () => {
  const { r } = await run();
  assert.ok(r.fits.every((f) => f.closest && PAST.some((p) => p.name === f.closest!.name)));
});

test("venues: only music rooms count, 'Empty Bottle' finds 'The Empty Bottle', and an unknown room is a clear 404", async () => {
  const { r } = await run();
  assert.equal(r.venue.name, "The Empty Bottle");
  assert.equal(r.venue.match, "exact");
  assert.ok(!r.venue.alternatives.some((a) => a.name === "Empty Bottle Records"), "a record store isn't a room");
  await assert.rejects(run({ venue: { name: "Nowhere Hall, Chicago" } }), /couldn't find "Nowhere Hall, Chicago" among Qloo's music venues/);
});

test("names: exact, closest (a typo, with alternatives), several sharing a name, and a picked ID", async () => {
  const { r } = await run({ acts: [{ name: "snail male" }, { name: "Twins" }, { name: "Twins", id: UUID(41) }, { name: "Nobody Here" }] });
  const byInput = Object.fromEntries(r.acts.map((a) => [`${a.input}:${a.match}`, a]));
  assert.equal(byInput["snail male:closest"].name, "Snail Mail");
  assert.ok(byInput["snail male:closest"].alternatives.length === 0, "an unrelated candidate isn't offered");
  assert.equal(byInput["Twins:ambiguous"].alternatives[0].id, UUID(41));
  assert.equal(r.unresolved[0], "Nobody Here");
  // The picked Twins is the same Qloo artist as the ambiguous one's alternative, so it's looked up by ID.
  const { r: r2, calls } = await run({ acts: [{ name: "Twins", id: UUID(41) }] });
  assert.equal(r2.acts[0].match, "chosen");
  assert.ok(calls.some((c) => c.path === "/entities"));
});

test("a search with 8 acts and 8 pitches stays inside the 48-call budget", async () => {
  const many = CATALOG.slice(0, 8).map((a) => ({ name: a.name }));
  const m = mockFetch(standardQloo());
  try {
    const budget = new Budget(48);
    await forVenue(ENV(memoryKV().kv), budget, { venue: { name: "Empty Bottle, Chicago" }, acts: many, pitches: CATALOG.slice(6, 14).map((a) => ({ name: a.name })), rising: true });
    assert.ok(budget.used <= 48, `used ${budget.used}`);
    assert.ok(m.calls.length <= 48);
    assert.ok(m.calls.some((c) => c.params.get("bias.trends") === "high"));
  } finally {
    m.restore();
  }
});

test("for an artist: cities by Qloo's affinity there, the rooms that fit, unknown cities named", async () => {
  const m = mockFetch(standardQloo());
  try {
    const r = await forArtist(ENV(memoryKV().kv) as any, new Budget(48), { artist: { name: "Wednesday" }, cities: ["Chicago, Illinois", "Austin, Texas", "Zzqx, Nowhere"] });
    assert.deepEqual(r.notFound, ["Zzqx, Nowhere"]);
    assert.ok(r.cities.every((c) => c.rooms.length > 0));
    const venueCall = m.calls.find((c) => c.params.get("filter.type") === "urn:entity:place")!;
    assert.equal(venueCall.params.get("filter.tags"), "urn:tag:category:place:live_music_venue,urn:tag:category:place:concert_hall");
    assert.equal(venueCall.params.get("operator.filter.tags"), "union");
    const scores = r.cities.map((c) => c.affinity ?? -1);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  } finally {
    m.restore();
  }
});

test("a city Qloo reads somewhere else (over 60 km away) is left out, not scored", async () => {
  const m = mockFetch((c) => {
    if (qloo(c) && c.path === "/v2/insights" && c.params.get("filter.type") === "urn:entity:artist" && c.params.get("signal.location.query")?.startsWith("Austin"))
      return { body: { results: { entities: [artist(10, "Wednesday", 0.955, ["Indie"], 0.9)] }, query: { localities: { signal: { name: "Austin, Minnesota", location: { lat: 43.67, lon: -92.97 } } } } } };
    return standardQloo()(c);
  });
  try {
    const r = await forArtist(ENV(memoryKV().kv) as any, new Budget(48), { artist: { name: "Wednesday" }, cities: ["Austin, Texas", "Chicago, Illinois"] });
    assert.deepEqual(r.notFound, ["Austin, Texas"]);
    assert.ok(r.trace.some((t) => /Austin, Minnesota/.test(t.detail)));
  } finally {
    m.restore();
  }
});

test("Qloo calls are paced: no more than one every 340 ms by default", async () => {
  const m = mockFetch(standardQloo());
  const starts: number[] = [];
  const mocked = globalThis.fetch;
  globalThis.fetch = (async (i: any, init?: any) => {
    if (new URL(typeof i === "string" ? i : i.url).host === "qloo.test") starts.push(Date.now());
    return mocked(i, init);
  }) as typeof fetch;
  try {
    const { QLOO_MIN_GAP_MS, ...live } = ENV(memoryKV().kv);
    await forArtist(live as any, new Budget(48), { artist: { name: "Wednesday" }, cities: ["Chicago, Illinois"] });
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    assert.ok(starts.length >= 3 && Math.min(...gaps) >= 330, `gaps ${gaps}`);
  } finally {
    m.restore();
  }
});

test("helpers: resemblance, names without 'the', music rooms, city spelling, list parsing", () => {
  assert.ok(resembles("snail male", "Snail Mail"));
  assert.ok(!resembles("zzqx", "Wednesday"));
  assert.equal(nameKey("The Empty Bottle"), nameKey("Empty Bottle"));
  assert.ok(isRoom({ id: "x", name: "x", types: [], categories: ["Bar", "Live music venue"] }));
  assert.ok(!isRoom({ id: "x", name: "x", types: [], categories: ["Record store"] }));
  assert.equal(cityOf({ id: "x", name: "x", types: [], city: "Chicago", region: "Illinois", countryCode: "US", country: "United States" }), "Chicago, Illinois");
  assert.equal(cityOf({ id: "x", name: "x", types: [], city: "London", region: "England", countryCode: "GB", country: "United Kingdom" }), "London, United Kingdom");
  assert.deepEqual(names("Simon and Garfunkel, Hovvdy\nhovvdy; Dehd", 8).list.map((n) => n.name), ["Simon and Garfunkel", "Hovvdy", "Dehd"]);
  assert.deepEqual(names([{ name: "Twins", id: "not-an-id" }], 8).list, [{ name: "Twins" }]);
  assert.deepEqual(cityList("Austin, Texas\nChicago, Illinois; Austin, Texas").list, ["Austin, Texas", "Chicago, Illinois"]);
});

test("the room keeps its city on the page even when Qloo can't use the city as a signal", async () => {
  const { r } = await run({}, { unknownCity: true });
  assert.equal(r.city, undefined);
  assert.equal(r.venue.city, "Chicago, Illinois");
});
