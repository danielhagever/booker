// The Worker's API, MCP tools and page. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { venueSummary, tourSummary } from "../src/index.ts";
import { ENV, artist, memoryKV, mockFetch, venue, type Call } from "./mock.ts";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const env = (kv = memoryKV().kv) => ({ ...ENV(kv), ASSETS: { fetch: async () => new Response("page") } as unknown as Fetcher });
const post = (path: string, body: unknown) => new Request(`https://booker.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// A small Qloo: one room, two acts, a few candidates.
function qloo(c: Call) {
  if (c.host !== "qloo.test") return undefined;
  if (c.path === "/search")
    return c.params.get("types") === "urn:entity:place"
      ? { body: { results: [venue(1, "The Empty Bottle", "Chicago", "Illinois")] } }
      : { body: { results: [artist(10, "Wednesday", 0.955), artist(11, "Hovvdy", 0.897)].filter((a) => a.name.toLowerCase() === c.params.get("query")!.toLowerCase()) } };
  if (c.path === "/v2/insights" && c.params.get("filter.type") === "urn:entity:artist")
    return { body: { results: { entities: [artist(20, "Dehd", 0.937, ["Indie"], 0.97), artist(24, "Dirt Buyer", 0.54, ["Indie"], 0.95)] } } };
  if (c.path === "/v2/insights") return { body: { results: { entities: [venue(1, "The Empty Bottle", "Chicago", "Illinois", undefined, 0.96)] } } };
  return undefined;
}

test("/api/venue checks its input and names what was left out", async () => {
  const bad = await worker.fetch(post("/api/venue", { venue: "x", acts: "" }), env());
  assert.equal(bad.status, 400);
  const m = mockFetch(qloo);
  try {
    const nine = Array.from({ length: 9 }, (_, i) => (i === 0 ? "Wednesday" : `Act ${i}`)).join(", ");
    const d: any = await (await worker.fetch(post("/api/venue", { venue: "The Empty Bottle, Chicago", acts: nine }), env())).json();
    assert.deepEqual(d.leftOut, ["Act 8"]);
    assert.match(d.summary, /^For The Empty Bottle \(Chicago\)/);
  } finally {
    m.restore();
  }
});

test("a repeat is answered from the day's cache and says so; a degraded result isn't kept", async () => {
  const m = mockFetch(qloo);
  try {
    const kv = memoryKV();
    const body = { venue: "The Empty Bottle, Chicago", acts: "Wednesday, Hovvdy" };
    const first: any = await (await worker.fetch(post("/api/venue", body), env(kv.kv))).json();
    const again: any = await (await worker.fetch(post("/api/venue", body), env(kv.kv))).json();
    assert.equal(first.cached, undefined);
    assert.equal(again.cached, true);
    assert.equal(again.computedAt, first.computedAt);
  } finally {
    m.restore();
  }
  const broken = mockFetch((c) => (c.host === "qloo.test" && c.path === "/v2/insights" && c.params.get("filter.type") === "urn:entity:place" ? { status: 500, body: {} } : qloo(c)));
  try {
    const kv = memoryKV();
    const r = await worker.fetch(post("/api/venue", { venue: "The Empty Bottle, Chicago", acts: "Wednesday" }), env(kv.kv));
    assert.equal(r.status, 200);
    assert.equal([...kv.store.keys()].filter((k) => k.startsWith("venue")).length, 0);
  } finally {
    broken.restore();
  }
});

test("an unexpected error is a plain 500 message, not internals", async () => {
  const m = mockFetch((c) => (c.host === "qloo.test" && c.path === "/search" ? { body: { results: { weird: true } } } : qloo(c)));
  try {
    const r = await worker.fetch(post("/api/venue", { venue: "The Empty Bottle, Chicago", acts: "Wednesday" }), env());
    const d: any = await r.json();
    assert.ok(r.status >= 400);
    assert.doesNotMatch(d.error, /TypeError|at |\.ts/);
  } finally {
    m.restore();
  }
});

test("MCP: both tools are listed with their guidance, and a call answers in words plus structured data", async () => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  const list = await (await worker.fetch(new Request("https://booker.test/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }), env())).text();
  assert.match(list, /find_acts_for_venue/);
  assert.match(list, /find_rooms_for_artist/);
  assert.match(list, /ask the person whether it's the one they meant/);
  const m = mockFetch(qloo);
  try {
    const call = new Request("https://booker.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_acts_for_venue", arguments: { venue: "The Empty Bottle, Chicago", acts: ["Wednesday", "Hovvdy"] } } }),
    });
    const text = await (await worker.fetch(call, env())).text();
    const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    assert.match(data.result.content[0].text, /For The Empty Bottle/);
    assert.equal(data.result.structuredContent.mode, "venue");
  } finally {
    m.restore();
  }
});

test("summaries rank only the cities Qloo scored", () => {
  const room = [{ name: "The Lexington" }];
  const lon = { label: "London, United Kingdom", rooms: room };
  assert.equal(tourSummary({ artist: { name: "Wednesday" }, cities: [lon] } as any), "Qloo has no city score for Wednesday in London. Best-fit rooms: The Lexington in London.");
  const both: any = { artist: { name: "Wednesday" }, cities: [{ label: "Asheville, North Carolina", affinity: 0.996, rooms: [] }, lon] };
  assert.equal(tourSummary(both), "Wednesday's crowd is strongest in Asheville (0.996). Qloo has no city score for London. Best-fit rooms: The Lexington in London.");
});

test("MCP: the answer names pitches that were only a closest match, with alternatives, and pitches not found", async () => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const m = mockFetch((c) =>
    c.host === "qloo.test" && c.path === "/search" && c.params.get("query") === "Wednsday"
      ? { body: { results: [artist(13, "Wednesday", 0.955), artist(14, "Wednesday Campanella", 0.8)] } }
      : qloo(c),
  );
  try {
    const call = new Request("https://booker.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "find_acts_for_venue", arguments: { venue: "The Empty Bottle, Chicago", acts: ["Wednesday"], pitches: ["Wednsday", "Nobody Real"] } } }),
    });
    const text = JSON.parse((await (await worker.fetch(call, env())).text()).split("\n").find((l) => l.startsWith("data: "))!.slice(6)).result.content[0].text;
    assert.match(text, /Pitch "Wednsday" was matched to Wednesday \[id [0-9a-f-]+\] \(closest Qloo match, not exactly what was typed\); alternatives: Wednesday Campanella \(Indie\) \[id /);
    assert.match(text, /Pitches not found in Qloo: Nobody Real\./);
  } finally {
    m.restore();
  }
});

test("summaries agree in number and read naturally", () => {
  const base: any = { venue: { name: "The Empty Bottle", city: "Chicago, Illinois" }, fits: [{ name: "Dehd" }], bills: [], inbox: [] };
  assert.equal(venueSummary(base), "For The Empty Bottle (Chicago), the acts that fit your crowd and size are Dehd.");
  const inbox = [{ verdict: "fits", id: "a" }, { verdict: "smaller", id: "b" }, { verdict: "off-taste", id: "c" }, { verdict: "off-taste", id: "d" }];
  assert.match(venueSummary({ ...base, inbox }), /From your inbox of 4: 1 fits your room, 1 fits as an opener and 2 are off your crowd's taste\.$/);
  const lost = [{ verdict: "unscored", id: "e" }, { verdict: "unscored", id: "" }, { verdict: "unscored", id: "" }];
  assert.match(venueSummary({ ...base, inbox: lost }), /From your inbox of 3: 1 couldn't be scored and 2 aren't in Qloo\.$/);
  const tour: any = { artist: { name: "Wednesday" }, cities: [{ label: "Asheville, North Carolina", affinity: 0.996, rooms: [{ name: "The Orange Peel" }] }, { label: "Chicago, Illinois", affinity: 0.964, rooms: [] }] };
  assert.equal(tourSummary(tour), "Wednesday's crowd is strongest in Asheville (0.996), then Chicago (0.964). Best-fit rooms: The Orange Peel in Asheville.");
});

test("the page escapes everything it shows (names come from Qloo and from visitors)", () => {
  const html = page.split("<script>")[1];
  const interpolations = [...html.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  const raw = interpolations.filter((x) => /\.(name|input|label|address|why|summary|error|note|detail|step|act|headliner|opener|qlooCity|city)\b/.test(x) && !/esc\(|f3\(|f2\(|\.length|\.map|join|=>/.test(x));
  assert.deepEqual(raw, [], "every name or text goes through esc()");
  assert.match(page, /bindTooltip\(`\$\{esc\(r\.name\)\}/);
});

test("the page labels a saved result, says Stopped on failure, and keeps the key off the browser", () => {
  assert.match(page, /d\.cached \?/);
  assert.match(page, /failed \? "Stopped"/);
  assert.doesNotMatch(page, /QLOO_API_KEY|x-api-key/i);
});

test("the page says when your room isn't among the rooms that fit the top act", () => {
  assert.match(page, /isn't in Qloo's top \$\{d\.rivals\.rooms\.length\} for this act/);
});

test("the acts' bars span the lowest to the highest affinity shown (Qloo's are close together)", () => {
  assert.match(page, /const w = hi > lo \? 20 \+ 80 \*/);
  assert.match(page, /Bars span the lowest to the highest Qloo affinity shown/);
});

test("switching tabs clears the other side's answer", () => {
  assert.match(page, /\$\("results"\)\.innerHTML = intro; \$\("side"\)\.innerHTML = ""/);
});

test("only new searches count against the hourly limit; a saved answer is free", async () => {
  const store = new Map<string, string>();
  const fake = { match: async (k: Request) => (store.has(k.url) ? new Response(store.get(k.url)) : undefined), put: async (k: Request, v: Response) => void store.set(k.url, await v.text()) };
  (globalThis as any).caches = { default: fake };
  const m = mockFetch(qloo);
  try {
    const kv = memoryKV();
    const body = { venue: "The Empty Bottle, Chicago", acts: "Wednesday" };
    for (let i = 0; i < 25; i++) assert.equal((await worker.fetch(post("/api/venue", body), env(kv.kv))).status, 200);
    assert.deepEqual([...store.values()], ["1"], "25 identical searches, one counted");
    for (let i = 2; i <= 20; i++) await worker.fetch(post("/api/venue", { ...body, acts: `Wednesday, Act ${i}` }), env(kv.kv));
    const over = await worker.fetch(post("/api/venue", { ...body, acts: "Wednesday, Act 21" }), env(kv.kv));
    assert.equal(over.status, 429);
    assert.match(((await over.json()) as any).error, /saved answers still work/);
    assert.equal((await worker.fetch(post("/api/venue", body), env(kv.kv))).status, 200, "a saved answer still works past the limit");
  } finally {
    m.restore();
    delete (globalThis as any).caches;
  }
});

test("both MCP tools tell the agent to ask the person when a name was only a closest match", async () => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  const list = await (await worker.fetch(new Request("https://booker.test/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }), env())).text();
  assert.equal(list.match(/ask the person whether it's the one they meant/g)?.length, 2);
});

test("the map keeps Leaflet's own zoom listener, and a late answer can't land on the other tab", () => {
  assert.doesNotMatch(page, /map\.off\("zoomend"\)/);
  assert.match(page, /const mine = \+\+current;/);
  assert.equal(page.match(/if \(mine !== current\) return;/g)?.length, 2);
  assert.match(page, /current\+\+; document\.querySelectorAll\("\.go"\)/);
  assert.match(page, /progress\(steps, 0\);/, "no step is shown done before the answer arrives");
});

test("MCP: the artist answer names the cities it left out", async () => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const m = mockFetch(qloo);
  try {
    const call = new Request("https://booker.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "find_rooms_for_artist", arguments: { artist: "Wednesday", cities: ["Chicago, Illinois", "Zzqx, Nowhere"] } } }),
    });
    const text = JSON.parse((await (await worker.fetch(call, env())).text()).split("\n").find((l) => l.startsWith("data: "))!.slice(6)).result.content[0].text;
    assert.match(text, /Cities left out \(not found, or Qloo placed them somewhere else\): Zzqx, Nowhere\./);
  } finally {
    m.restore();
  }
});

test("the page offers Not it? whenever Qloo had other candidates, so a wrong exact match can be put right", () => {
  assert.match(page, /const choose = p\.match !== "chosen" && p\.alternatives\.length/);
});


test("the page shows how a city was read when its comma part didn't match", () => {
  assert.match(page, /c\.note \? `<div class="m" style="color:var\(--warn\)">\$\{esc\(c\.note\)\}<\/div>`/);
});

test("rooms show their main categories (Qloo's first two) and a later music one, in the city cards and the rooms in town", () => {
  assert.match(page, /c\.slice\(0, 2\)\.join\(", "\) \+ \(music && !c\.slice\(0, 2\)\.includes\(music\)/);
  assert.equal(page.match(/esc\(roomCats\(r\.categories\)\)/g)?.length, 2);
});

test("the artist summary doesn't repeat a city in a room's name, and shows a fourth decimal rather than a false tie", () => {
  const t: any = { artist: { name: "Lana Del Rey" }, cities: [
    { label: "Paris, France", affinity: 0.99981, rooms: [{ name: "The American Cathedral in Paris" }] },
    { label: "Berlin, Germany", affinity: 0.99962, rooms: [] },
  ] };
  assert.equal(tourSummary(t), "Lana Del Rey's crowd is strongest in Paris (0.9998), then Berlin (0.9996). Best-fit rooms: The American Cathedral in Paris.");
});

test("MCP: one tool call per request, and blank names are refused before any search counts or Qloo call", async () => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  const call = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const m = mockFetch(qloo);
  try {
    const batch = await worker.fetch(new Request("https://booker.test/mcp", { method: "POST", headers, body: JSON.stringify([call(1, "find_rooms_for_artist", { artist: "Wednesday", cities: ["Chicago, Illinois"] }), call(2, "find_rooms_for_artist", { artist: "Hovvdy", cities: ["Chicago, Illinois"] })]) }), env());
    assert.equal(batch.status, 400);
    assert.match(await batch.text(), /one tool call per request/);
    assert.equal(m.calls.length, 0);
    for (const [name, args] of [["find_acts_for_venue", { venue: "The Empty Bottle, Chicago", acts: ["   "] }], ["find_rooms_for_artist", { artist: " ", cities: ["Chicago, Illinois"] }]] as const) {
      const text = await (await worker.fetch(new Request("https://booker.test/mcp", { method: "POST", headers, body: JSON.stringify(call(3, name, args)) }), env())).text();
      const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
      assert.equal(data.result.isError, true, name);
    }
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test("the venue summary doesn't repeat a city that's in the venue's name", () => {
  const r: any = { venue: { name: "Mohawk Austin", city: "Austin, Texas" }, fits: [{ name: "Allah-Las" }], bills: [], inbox: [] };
  assert.match(venueSummary(r), /^For Mohawk Austin, the acts/);
  assert.match(venueSummary({ ...r, venue: { name: "The Empty Bottle", city: "Chicago, Illinois" } }), /^For The Empty Bottle \(Chicago\), the acts/);
  assert.match(venueSummary({ ...r, venue: { name: "Adams Hall", city: "Ada, Oklahoma" } }), /^For Adams Hall \(Ada\), the acts/, "a whole word, not part of one");
  assert.match(page, /const matchNote = \(p\) => \(!p\.id \? ""/, "a pitch not found in Qloo has no match label");
});

test("the inbox shows how each pitch was matched, and Not it? can change a pitch as well as an act", () => {
  assert.match(page, /pickRow\(p, `altP\$\{i\}`, "pitch"\)/);
  assert.match(page, /chosen\(p\.input, "pitch"\)/);
  assert.match(page, /p\.match === "ambiguous" \? "several match this name"/);
});
