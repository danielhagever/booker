// Name matching against 472 realistic inputs (test/name-cases.mjs). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { forSearch, rankNames, resolveArtist, resolveVenue, together, withoutNote } from "../src/resolve.ts";
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
const fake = (found: unknown[]) => ({ search: async () => found, byIds: async () => [], budget: { left: () => 48 } }) as any;
const show = (r: any) => (r ? `${r.entity.name}${r.entity.city ? ` [${r.entity.city}]` : ""} ${r.match}` : "none");
const is = (...want: string[]) => (out: string) => want.includes(out);
const starts = (...want: string[]) => (out: string) => want.some((w) => out.startsWith(w));
const eqList = (...xs: string[]) => (out: string) => out === JSON.stringify(xs);

test("name matching: 472 realistic inputs, each with the answer a reasonable person expects", async () => {
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
  assert.equal(count, 472);
  assert.deepEqual(wrong, []);
});

test("an act's note in brackets: when the whole text finds nothing like the name, the name alone is searched (live: 'Lafayette Afro Rock Band')", async () => {
  const asked: string[] = [];
  const q = { search: async (t: string) => (asked.push(t), t === "Wednesday" ? [art("Wednesday"), art("Wednesday 13")] : [art("Lafayette Afro Rock Band")]), byIds: async () => [], budget: { left: () => 48 } } as any;
  assert.equal(show(await resolveArtist(q, "Wednesday (indie rock band)")), "Wednesday closest");
  assert.deepEqual(asked, ["Wednesday (indie rock band)", "Wednesday"]);
  // An act's note is never another name: when the name alone finds nothing either, the act is not found.
  asked.length = 0;
  const alias = { search: async (t: string) => (asked.push(t), t === "Yasiin Bey (Mos Def)" ? [art("Mos Def")] : []), byIds: async () => [], budget: { left: () => 48 } } as any;
  assert.equal(show(await resolveArtist(alias, "Yasiin Bey (Mos Def)")), "none");
  assert.deepEqual(asked, ["Yasiin Bey (Mos Def)", "Yasiin Bey"]);
});

test("acts with a note in brackets on Qloo's live answers get the act a reasonable person expects", async () => {
  const { T } = await import("./note-cases.mjs" as string);
  const F = JSON.parse(readFileSync(new URL("./note-fixtures.json", import.meta.url), "utf8"));
  const wrong: string[] = [];
  let count = 0;
  for (const [input, kind, want] of T) {
    if (kind !== "artist") continue;
    count++;
    const q = { search: async (t: string) => F[`artist|${t}`] ?? assert.fail(`no recorded answer for ${t}`), byIds: async () => [], budget: { left: () => 48 } } as any;
    const r = await resolveArtist(q, input);
    const got = r ? r.entity.name : "none";
    if (!want(got)) wrong.push(`${input} -> ${got}`);
  }
  assert.equal(count, 41);
  assert.deepEqual(wrong, []);
});

test("the name alone is searched a second time only while the request has calls to spare", async () => {
  const asked: string[] = [];
  const q = (left: number) => ({ search: async (t: string) => (asked.push(t), t === "Wednesday" ? [art("Wednesday")] : []), byIds: async () => [], budget: { left: () => left } }) as any;
  assert.equal(show(await resolveArtist(q(21), "Wednesday (indie rock band)")), "Wednesday closest");
  assert.deepEqual(asked, ["Wednesday (indie rock band)", "Wednesday"]);
  asked.length = 0;
  assert.equal(show(await resolveArtist(q(20), "Wednesday (indie rock band)")), "none", "with 20 calls left, the rest of the search keeps them");
  assert.deepEqual(asked, ["Wednesday (indie rock band)"]);
  // Pitches come last, when the rest of the search needs only a few calls.
  asked.length = 0;
  assert.equal(show(await resolveArtist(q(9), "Wednesday (indie rock band)", 8)), "Wednesday closest");
  assert.deepEqual(asked, ["Wednesday (indie rock band)", "Wednesday"]);
});

// Booker's copy of the note rules is the same code as Newcomer's; the whole recorded table runs here too, so a change
// to this copy is caught here (only its act rows go through resolveArtist above).
test("notes in brackets on Qloo's live answers: every recorded input gets the entry a reasonable person expects (known limits listed)", async () => {
  const { T } = await import("./note-cases.mjs" as string);
  const F = JSON.parse(readFileSync(new URL("./note-fixtures.json", import.meta.url), "utf8"));
  const label = (e: any) => `${e.name}${e.disambiguation && e.disambiguation.toLowerCase() !== e.name.toLowerCase() ? ` (${e.disambiguation})` : ""}`;
  const wrong: string[] = [];
  const known: string[] = [];
  for (const [input, kind, want, limit] of T) {
    const whole = F[`${kind}|${forSearch(input)}`];
    let r = rankNames(whole, input);
    if (withoutNote(input) !== input && (!r || r.searchName)) r = rankNames(together(whole, F[`${kind}|${withoutNote(input)}`]), input);
    const got = r ? label(r.pick) : "none";
    if (limit) known.push(input);
    if (!want(got)) wrong.push(input);
  }
  assert.equal(T.length, 268);
  // Every miss is a known limit, and every known limit still misses (so a fix there is noticed).
  assert.deepEqual(wrong, known);
});

test("a number word after a part word is searched as a digit", () => {
  assert.equal(forSearch("Star Wars (Episode One)"), "Star Wars (Episode 1)");
  assert.equal(forSearch("Fast & Furious (Fast Five)"), "Fast & Furious (Fast Five)");
});

test("Not it? with a note: the note's own titles first, otherwise only entries holding the name (Qloo's live answers)", () => {
  const F = JSON.parse(readFileSync(new URL("./note-fixtures.json", import.meta.url), "utf8"));
  const offers = (input: string, kind: string) => {
    const r = rankNames(together(F[`${kind}|${forSearch(input)}`], F[`${kind}|${withoutNote(input)}`]), input)!;
    return r.list.filter((e) => e !== r.pick && r.offered(e)).map((e) => e.name);
  };
  assert.equal(offers("Chicago P.D. (Chicago Fire)", "tv_show")[0], "Chicago Fire");
  assert.equal(offers("Better Call Saul (Breaking Bad)", "tv_show")[0], "Breaking Bad");
  assert.equal(offers("Whitney (Whitney Houston)", "movie")[0], "Whitney Houston: I Wanna Dance with Somebody");
  assert.equal(offers("Fear the Walking Dead (The Walking Dead)", "tv_show")[0], "The Walking Dead");
  assert.equal(offers("That '90s Show (That '70s Show)", "tv_show")[0], "That '70s Show");
  for (const [input, kind] of [["Dune (Part Two)", "movie"], ["The Godfather (Part II)", "movie"], ["It (Chapter Two)", "movie"], ["Rambo (First Blood)", "movie"]]) {
    const name = withoutNote(input).toLowerCase().replace(/^the /, "");
    assert.deepEqual(offers(input, kind).filter((n) => !n.toLowerCase().includes(name)), [], input);
    assert.equal(new Set(offers(input, kind)).size, offers(input, kind).length, `${input}: offered twice`);
  }
});

test("a number-only note counts titles starting with the name by year, but not titles numbered otherwise (real titles)", () => {
  let n = 0;
  const film = (name: string, year: string) => ({ id: `f${++n}`, name, types: ["urn:entity:movie"], disambiguation: year });
  const pick = (input: string, found: any[]) => { const r = rankNames(found, input); return r ? `${r.pick.name} (${r.pick.disambiguation})` : "none"; };
  assert.equal(pick("The Hunger Games (3)", [film("The Hunger Games", "2012"), film("The Hunger Games: Mockingjay - Part 2", "2015"), film("The Hunger Games: Catching Fire", "2013"), film("The Hunger Games: Mockingjay - Part 1", "2014")]), "The Hunger Games: Mockingjay - Part 1 (2014)");
  assert.equal(pick("Rocky (2)", [film("Rocky", "1976"), film("Rocky III", "1982"), film("Rocky IV", "1985")]), "Rocky (1976)");
  assert.equal(pick("The Matrix (2)", [film("The Matrix", "1999"), film("The Making of The Matrix", "2001"), film("The Matrix Reloaded", "2003")]), "The Matrix Reloaded (2003)");
  assert.equal(pick("Toy Story (1)", [film("Toy Story That Time Forgot", "2014"), film("Toy Story", "1995")]), "Toy Story (1995)");
  assert.equal(pick("Mission: Impossible (Dead Reckoning)", [film("Mission: Impossible - Dead Reckoning Part One", "2023"), film("Dead Reckoning", "1947")]), "Mission: Impossible - Dead Reckoning Part One (2023)");
  assert.equal(pick("Mission: Impossible (Dead Reckoning film)", [film("Mission: Impossible - Dead Reckoning", "2023"), film("Dead Reckoning", "1947")]), "Mission: Impossible - Dead Reckoning (2023)");
  assert.equal(pick("The Hunger Games (3)", [film("The Hunger Games: Mockingjay - Part 2", "2015"), film("The Hunger Games", "2012"), film("The Hunger Games: Catching Fire", "2013"), film("The Hunger Games: Mockingjay - Part 1", "2014")]), "The Hunger Games: Mockingjay - Part 1 (2014)");
  assert.equal(pick("Fantastic 4 (2)", [film("Fantastic Four: Rise of the Silver Surfer", "2007"), film("The Fantastic Four: First Steps", "2025")]), "Fantastic Four: Rise of the Silver Surfer (2007)");
  assert.equal(pick("The Matrix (2)", [film("The Matrix", "1999"), film("The Matrix Resurrections", "2021"), film("The Matrix Reloaded", "2003")]), "The Matrix Reloaded (2003)");
  assert.equal(pick("Twilight (2)", [film("Inside Out 2", "2024"), film("Twilight", "2008"), film("The Twilight Saga: New Moon", "2009")]), "The Twilight Saga: New Moon (2009)");
  assert.equal(pick("The Matrix (2)", [film("Dark City", "1998"), film("The Matrix", "1999"), film("The Matrix Reloaded", "2003")]), "The Matrix Reloaded (2003)");
});
