// Names typed by a person become Qloo entities the way Qloo's official harness resolves them: an exact
// name is preferred. Qloo's search returns something for almost any text, so a candidate that isn't
// the exact name is used only if it resembles what was typed; the answer says so and offers the others.

import { Qloo, normalizeName, type Entity } from "./qloo.ts";

export interface Choice {
  id: string;
  name: string;
  note?: string; // what tells it apart: a city for a venue, a genre for an artist
}

export interface Resolved {
  input: string; // what the person typed
  entity: Entity;
  // exact: one Qloo name matched; ambiguous: several share it (the first, the more popular, is used);
  // closest: no exact name, the top resembling candidate is used; chosen: the person picked it by ID.
  match: "exact" | "ambiguous" | "closest" | "chosen";
  alternatives: Choice[];
}

const STOP = new Set(["the", "a", "an", "of", "and", "&"]);
// Accents are folded too: "Beyonce" is Beyoncé and "Sigur Ros" is Sigur Rós.
const words = (s: string) =>
  normalizeName(s).normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
// "The Empty Bottle" and "Empty Bottle" are the same name; so are "Snail Mail" and "snail mail".
export const nameKey = (s: string) => words(s).join(" ");

function typoDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

// Whole words only ("Bea" isn't Beach House). The typed text is part of the name ("Gary Clark" is Gary
// Clark Jr.); or the name is part of the typed text and at least half of it ("Nobody Real Band Xyz" isn't
// The Band); or at least half the typed words appear in the name, allowing a typo or two.
export function resembles(typed: string, name: string): boolean {
  return wordsResemble(words(typed), words(name), true);
}

function wordsResemble(a: string[], b: string[], half: boolean): boolean {
  if (!a.length || !b.length) return false;
  const A = ` ${a.join(" ")} `, B = ` ${b.join(" ")} `;
  if (B.includes(A) || (A.includes(B) && (!half || b.length * 2 >= a.length))) return true;
  const close = (w: string) => b.some((x) => x === w || typoDistance(w, x) <= (w.length > 5 ? 2 : w.length > 3 ? 1 : 0));
  return a.filter(close).length / a.length >= 0.5;
}

// Venues. A venue is typed with its city, with or without a comma ("Bowery Ballroom New York City"), and
// Qloo sometimes names a place with its city ("Mohawk Austin") or a kind of room ("Antone's Nightclub").
// Each candidate is compared with what was typed in tiers: the full name (the candidate's own city
// dropped from the end of both names, and from the typed text only when there's no comma), then the name
// without generic words at the end ("theatre", "club", "auditorium"). A room in the typed city comes first.
const GENERIC = new Set(["theatre", "theater", "club", "nightclub", "ballroom", "hall", "bar", "pub", "lounge", "room", "music", "live", "venue", "tavern", "saloon", "cafe", "auditorium", "amphitheatre", "amphitheater", "arena", "center", "centre", "stage"]);
const dropEnd = (ws: string[], drop: (w: string) => boolean) => {
  const out = [...ws];
  while (out.length > 1 && drop(out[out.length - 1])) out.pop();
  return out;
};
const covers = (have: string[], want: string[]) => want.length > 0 && want.every((w) => have.includes(w));

export function chooseVenue(input: string, found: Entity[]): { pick: Entity; exact: Entity[]; list: Entity[] } | null {
  const comma = input.indexOf(",");
  const typedName = words(comma < 0 ? input : input.slice(0, comma));
  const typedCity = comma < 0 ? [] : words(input.slice(comma + 1));
  // For a near miss, only the words that name a room count: no city or state word of any candidate
  // (some records have no city) and no generic word, so "New York City Center" doesn't resemble the
  // Bowery Ballroom typed with its city.
  const places = new Set([...found.flatMap((e) => words([e.city, e.region].filter(Boolean).join(" "))), "city"]);
  const content = (ws: string[]) => ws.filter((w) => !places.has(w) && !GENERIC.has(w));
  const typedContent = content(typedName);
  const scored = found.map((e, order) => {
    const city = words(e.city ?? "");
    const own = new Set([...city, ...words(e.region ?? ""), "city"]);
    // Without a comma the city may close the typed text: "Mohawk Austin", "Bowery Ballroom New York City".
    // Its own city puts the room in the typed city; another result's city ("Troubadour Los Angeles" for a
    // room in West Hollywood) only counts for the name.
    const typed = comma < 0 ? dropEnd(typedName, (w) => own.has(w)) : typedName;
    const typedAny = comma < 0 ? dropEnd(typedName, (w) => own.has(w) || places.has(w)) : typedName;
    const inCity = covers(typedCity, city) || (comma < 0 && typed.length < typedName.length && covers(typedName.slice(typed.length), city));
    const name = dropEnd(words(e.name), (w) => city.includes(w));
    const same = (a: string[], b: string[]) => a.join(" ") === b.join(" ");
    const bare = (ws: string[]) => dropEnd(ws, (w) => GENERIC.has(w));
    const full = same(typed, name) || same(typedAny, name);
    const loose = same(bare(typed), bare(name)) || same(bare(typedAny), bare(name));
    const tier = full && inCity ? 0 : loose && inCity ? 1 : full ? 2 : loose ? 3 : wordsResemble(typedContent, content(name), false) ? 4 : 5;
    const music = (e.categories ?? []).some((c) => MUSIC.test(c));
    return { e, tier, inCity, music, order };
  });
  // Best tier first, then the typed city, then music venues, then Qloo's order.
  const ranked = scored.filter((x) => x.tier < 5).sort((a, b) => a.tier - b.tier || Number(b.inCity) - Number(a.inCity) || Number(b.music) - Number(a.music) || a.order - b.order);
  if (!ranked.length) return null;
  const best = ranked[0].tier;
  const exact = best < 4 ? ranked.filter((x) => x.tier === best).map((x) => x.e) : [];
  return { pick: ranked[0].e, exact, list: ranked.map((x) => x.e) };
}

const label = (e: Entity) => (e.disambiguation && nameKey(e.disambiguation) !== nameKey(e.name) ? `${e.name} (${e.disambiguation})` : e.name);

// Artists: 5 candidates, like the harness.
export async function resolveArtist(q: Qloo, input: string): Promise<Resolved | null> {
  const found = (await q.search(input, "urn:entity:artist", 5)).filter((e) => e.types.includes("urn:entity:artist") || !e.types.length);
  const exact = found.filter((e) => nameKey(e.name) === nameKey(input));
  const list = found.filter((e) => exact.includes(e) || resembles(input, e.name));
  if (!list.length) return null;
  const pick = exact[0] ?? list[0];
  return {
    input,
    entity: pick,
    match: exact.length === 1 ? "exact" : exact.length > 1 ? "ambiguous" : "closest",
    alternatives: list.filter((e) => e.id !== pick.id).slice(0, 4).map((e) => ({ id: e.id, name: label(e), note: e.genres?.[0] })),
  };
}

// A place counts as a room if Qloo files it as a music venue, a theater, or a bar or club where small
// shows happen (categories measured on Qloo place records); golf, country and health clubs don't.
const ROOM = /\b(live music|concert hall|music venue|night ?club|jazz club|event venue|performing arts theater|theater|theatre|amphitheater|auditorium|bar|pub|lounge|club)\b/i;
const NOT_ROOM = /\b(golf|country club|health club|fitness|gym|tennis|yacht|swim|athletic|sports club)\b/i;
const MUSIC = /\b(live music|concert hall|music venue|jazz club|night ?club)\b/i;
export const isRoom = (e: Entity) => {
  const cats = e.categories ?? [];
  return cats.some((c) => ROOM.test(c)) && (cats.some((c) => MUSIC.test(c)) || !cats.some((c) => NOT_ROOM.test(c)));
};
// Venues: "The Empty Bottle, Chicago". The whole text goes to Qloo's place search (the city helps it);
// chooseVenue decides exact, ambiguous or closest.
export async function resolveVenue(q: Qloo, input: string): Promise<Resolved | null> {
  const found = (await q.search(input.replace(/,/g, " "), "urn:entity:place", 8)).filter(isRoom);
  const chosen = chooseVenue(input, found);
  if (!chosen) return null;
  const { pick, exact, list } = chosen;
  return {
    input,
    entity: pick,
    match: exact.length === 1 ? "exact" : exact.length > 1 ? "ambiguous" : "closest",
    alternatives: list.filter((e) => e.id !== pick.id).slice(0, 4).map((e) => ({ id: e.id, name: e.name, note: [e.city, e.region].filter(Boolean).join(", ") })),
  };
}

// An ID the person picked from the alternatives of an earlier answer.
export async function resolveChosen(q: Qloo, input: string, id: string): Promise<Resolved | null> {
  const [e] = await q.byIds([id]);
  return e ? { input, entity: e, match: "chosen", alternatives: [] } : null;
}
