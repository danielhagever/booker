// City lookup against 340 realistic ways people type tour cities (test/geo-cases.json), each with the
// city it should land on and whether the answer should flag what followed the comma. The geocoder's real
// answers were recorded once (test/geo-fixtures.json, trimmed), so this runs offline. Not included, because
// Open-Meteo has no good answer for them: Oahu, Big Island, Orange County, "Stoke, UK", "Kingston, UK", and
// the bare names Newcastle, Victoria and Hong Kong, which are ambiguous. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cityCenter } from "../src/geo.ts";
import { Budget } from "../src/limits.ts";
import { memoryKV } from "./mock.ts";

const FIX: Record<string, unknown[]> = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL("./geo-fixtures.json", import.meta.url), "utf8")) as Record<string, unknown[]>).map(([k, v]) => [decodeURIComponent(k), v]),
);
const CASES: [string, string, string | null][] = JSON.parse(readFileSync(new URL("./geo-cases.json", import.meta.url), "utf8"));

test("city lookup: 340 realistic inputs land on the right city, and only real mismatches are flagged", async () => {
  const original = globalThis.fetch;
  const missing = new Set<string>();
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    const key = decodeURIComponent(`${u.pathname.replace("/v1/", "")}${u.search}`);
    if (!(key in FIX)) missing.add(key);
    // /v1/search answers { results: [...] }; /v1/get answers the one record.
    const body = key.startsWith("get?") ? (FIX[key]?.[0] ?? {}) : { results: FIX[key] ?? [] };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const wrong: string[] = [];
  try {
    for (const [typed, want, note] of CASES) {
      const p = await cityCenter(memoryKV().kv, new Budget(48), typed);
      const got = p ? p.name : "NULL (not placed)";
      if (got !== want || (p?.unmatched ?? null) !== note) wrong.push(`${typed} -> ${got}${p?.unmatched ? ` [note ${p.unmatched}]` : ""}, want ${want}${note ? ` [note ${note}]` : ""}`);
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual([...missing], [], "every geocoder call has a recorded answer");
  assert.equal(CASES.length, 340);
  assert.deepEqual(wrong, []);
});
