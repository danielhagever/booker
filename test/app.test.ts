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
  assert.match(list, /ask the person which one they meant/);
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

test("summaries agree in number and read naturally", () => {
  const base: any = { venue: { name: "The Empty Bottle", city: "Chicago, Illinois" }, fits: [{ name: "Dehd" }], bills: [], inbox: [] };
  assert.equal(venueSummary(base), "For The Empty Bottle (Chicago), the acts that fit your crowd and size are Dehd.");
  const inbox = [{ verdict: "fits" }, { verdict: "smaller" }, { verdict: "off-taste" }, { verdict: "off-taste" }];
  assert.match(venueSummary({ ...base, inbox }), /From your inbox of 4: 1 fits your room, 1 fits as an opener and 2 are off your crowd's taste\.$/);
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
