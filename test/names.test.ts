// Name matching against 448 realistic inputs (test/name-cases.mjs). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveArtist, resolveVenue } from "../src/resolve.ts";
import { names } from "../src/input.ts";
// @ts-ignore: plain JavaScript table
import cases from "./name-cases.mjs";

// Real Qloo place records carry coordinates; these are the cities' (for "in the area" checks).
const COORDS: Record<string, { lat: number; lon: number }> = {"Amsterdam|North Holland": {"lat": 52.37, "lon": 4.9}, "Asbury Park|New Jersey": {"lat": 40.22, "lon": -74.01}, "Atlanta|Georgia": {"lat": 33.75, "lon": -84.39}, "Austin|Texas": {"lat": 30.27, "lon": -97.74}, "Bloomington|Indiana": {"lat": 39.17, "lon": -86.53}, "Boston|Massachusetts": {"lat": 42.36, "lon": -71.06}, "Brooklyn|New York": {"lat": 40.68, "lon": -73.94}, "Cambridge|Massachusetts": {"lat": 42.37, "lon": -71.11}, "Carrboro|North Carolina": {"lat": 35.91, "lon": -79.08}, "Chapel Hill|North Carolina": {"lat": 35.91, "lon": -79.06}, "Chicago|Illinois": {"lat": 41.88, "lon": -87.63}, "Dallas|Texas": {"lat": 32.78, "lon": -96.8}, "Denver|Colorado": {"lat": 39.74, "lon": -104.99}, "Detroit|Michigan": {"lat": 42.33, "lon": -83.05}, "Hollywood|Florida": {"lat": 26.01, "lon": -80.15}, "Houston|Texas": {"lat": 29.76, "lon": -95.37}, "Huntington|New York": {"lat": 40.87, "lon": -73.43}, "Kansas City|Missouri": {"lat": 39.1, "lon": -94.58}, "Las Vegas|Nevada": {"lat": 36.17, "lon": -115.14}, "Lawrence|Kansas": {"lat": 38.97, "lon": -95.24}, "Lexington|Kentucky": {"lat": 38.04, "lon": -84.5}, "Los Angeles|California": {"lat": 34.05, "lon": -118.24}, "Minneapolis|Minnesota": {"lat": 44.98, "lon": -93.27}, "Mohawk|New York": {"lat": 43.01, "lon": -75.0}, "Morrison|Colorado": {"lat": 39.65, "lon": -105.19}, "Nashville|Tennessee": {"lat": 36.16, "lon": -86.78}, "New York|New York": {"lat": 40.71, "lon": -74.01}, "Oakland|California": {"lat": 37.8, "lon": -122.27}, "Philadelphia|Pennsylvania": {"lat": 39.95, "lon": -75.17}, "Portland|Maine": {"lat": 43.66, "lon": -70.26}, "Portland|Oregon": {"lat": 45.52, "lon": -122.68}, "Portsmouth|New Hampshire": {"lat": 43.07, "lon": -70.76}, "Saint Paul|Minnesota": {"lat": 44.95, "lon": -93.09}, "San Antonio|Texas": {"lat": 29.42, "lon": -98.49}, "San Francisco|California": {"lat": 37.77, "lon": -122.42}, "Seattle|Washington": {"lat": 47.61, "lon": -122.33}, "Silver Spring|Maryland": {"lat": 38.99, "lon": -77.03}, "Somerville|Massachusetts": {"lat": 42.39, "lon": -71.1}, "St. Louis|Missouri": {"lat": 38.63, "lon": -90.2}, "Toronto|Ontario": {"lat": 43.65, "lon": -79.38}, "Tucson|Arizona": {"lat": 32.22, "lon": -110.97}, "Washington|District of Columbia": {"lat": 38.91, "lon": -77.04}, "West Hollywood|California": {"lat": 34.09, "lon": -118.36}};
let n = 0;
const place = (name: string, city?: string, region?: string, categories = ["Live music venue"], extra = {}) => ({
  id: String(++n), name, types: [], categories,
  ...(city ? { city, region, country: "United States", countryCode: "US", ...(COORDS[`${city}|${region}`] ?? {}) } : {}),
  ...extra,
});
const art = (name: string, genre = "Indie") => ({ id: `a${++n}`, name, types: ["urn:entity:artist"], genres: [genre] });
const fake = (found: unknown[]) => ({ search: async () => found, byIds: async () => [] }) as any;
const show = (r: any) => (r ? `${r.entity.name}${r.entity.city ? ` [${r.entity.city}]` : ""} ${r.match}` : "none");
const is = (...want: string[]) => (out: string) => want.includes(out);
const starts = (...want: string[]) => (out: string) => want.some((w) => out.startsWith(w));
const eqList = (...xs: string[]) => (out: string) => out === JSON.stringify(xs);

test("name matching: 448 realistic inputs, each with the answer a reasonable person expects", async () => {
  const wrong: string[] = [];
  let count = 0;
  const check = (kind: string, typed: string, out: string, ok: (o: string) => boolean) => {
    count++;
    if (!ok(out)) wrong.push(`${kind} ${JSON.stringify(typed)} -> ${out}`);
  };
  await cases({
    place, art, is, starts, eqList,
    runVenue: async (typed: string, found: unknown[], ok: (o: string) => boolean) => check("venue", typed, show(await resolveVenue(fake(found), typed)), ok),
    runArtist: async (typed: string, found: unknown[], ok: (o: string) => boolean) => check("artist", typed, show(await resolveArtist(fake(found), typed)), ok),
    runSplit: (text: string, ok: (o: string) => boolean) => check("split", text, JSON.stringify(names(text, 8).list.map((x) => x.name)), ok),
  });
  assert.equal(count, 448);
  assert.deepEqual(wrong, []);
});
