// Names typed by a person become Qloo entities the way Qloo's official harness resolves them: an exact
// name is preferred. Qloo's search returns something for almost any text, so a candidate that isn't
// the exact name is used only if it resembles what was typed; the answer says so and offers the others.

import { Qloo, normalizeName, type Entity } from "./qloo.ts";
import { km } from "./geo.ts";

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

// Only a leading article is dropped ("The Empty Bottle" is Empty Bottle), and "&" is "and"; "of" stays,
// since of Montreal isn't Montreal.
const ARTICLES = new Set(["the", "a", "an"]);
const FOLD: Record<string, string> = { "\u00f8": "o", "\u00e6": "ae", "\u0153": "oe", "\u00df": "ss", "\u0142": "l", "\u0111": "d", "\u00fe": "th" };
// Accents are folded ("Beyonce" is Beyoncé); apostrophes, colons and dots join ("Cat's" is "Cats", "9:30"
// is "930"); other punctuation separates words.
const SPELLING: Record<string, string> = { theater: "theatre", amphitheater: "amphitheatre", centre: "center" };
const words = (s: string) => {
  const ws = normalizeName(s)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u00f8\u00e6\u0153\u00df\u0142\u0111\u00fe]/g, (c) => FOLD[c])
    .replace(/[&+]/g, " and ") // "Florence + the Machine", "Simon & Garfunkel"
    .replace(/['\u2018\u2019`:.]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SPELLING[w] ?? w);
  return ws.length > 1 && ARTICLES.has(ws[0]) ? ws.slice(1) : ws;
};
// "The Empty Bottle" and "Empty Bottle" are the same name; so are "Snail Mail" and "snail mail".
export const nameKey = (s: string) => words(s).join(" ");
// Without spaces, "S. G. Goodman" is S.G. Goodman: used only for initials (a one-letter word on either
// side) and only when no name is equal with its spaces, since Wild Child and Wildchild are different acts.
export const squashed = (s: string) => words(s).join("");

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

// Venues. What is typed is the room's name, then perhaps where it is: "Mohawk, Austin", "Texas Theatre
// Dallas, TX", "Bowery Ballroom New York City". A candidate matches if its name opens the typed text
// (spaces and punctuation aside: "Exit In" is Exit/In) and everything after the name is the candidate's
// own location: its city, state, state code or country. Tiers: the full name in the typed city; the name
// without a generic ending ("Antone's" for Antone's Nightclub) in the typed city; the full name; the name
// without a generic ending; then near misses, judged on the words that name a room and ranked by how
// close they are. Qloo sometimes puts the city in the name ("Mohawk Austin"); that counts as location.
const GENERIC = new Set(["theatre", "theater", "club", "nightclub", "ballroom", "hall", "bar", "pub", "lounge", "room", "music", "live", "venue", "tavern", "saloon", "cafe", "auditorium", "amphitheatre", "amphitheater", "arena", "center", "centre", "stage"]);
const STATE_CODES: Record<string, string> = Object.fromEntries(
  Object.entries({
    alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co", connecticut: "ct", delaware: "de",
    "district of columbia": "dc", florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
    kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn",
    mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv", "new hampshire": "nh", "new jersey": "nj",
    "new mexico": "nm", "new york": "ny", "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok", oregon: "or",
    pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc", "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut",
    vermont: "vt", virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi", wyoming: "wy", ontario: "on",
    quebec: "qc", "british columbia": "bc", alberta: "ab", manitoba: "mb", "nova scotia": "ns",
  }).map(([k, v]) => [words(k).join(" "), v]),
);
// Newspaper (AP) abbreviations, dots dropped: "Portland, Ore.", "Oakland, Calif."
const STATE_AP: Record<string, string> = {
  alabama: "ala", arizona: "ariz", arkansas: "ark", california: "calif", colorado: "colo", connecticut: "conn", delaware: "del",
  florida: "fla", illinois: "ill", indiana: "ind", kansas: "kan", massachusetts: "mass", michigan: "mich", minnesota: "minn",
  mississippi: "miss", montana: "mont", nebraska: "neb", nevada: "nev", oklahoma: "okla", oregon: "ore", tennessee: "tenn",
  texas: "tex", washington: "wash", "west virginia": "wva", wisconsin: "wis", wyoming: "wyo",
};
// What people type for a city: "Fillmore SF", "Brooklyn Bowl, NYC" (Brooklyn is in New York City).
const CITY_ALIASES: Record<string, string[]> = {
  "new york": ["nyc"], brooklyn: ["nyc"], queens: ["nyc"], bronx: ["nyc"], manhattan: ["nyc"], "san francisco": ["sf"],
  "los angeles": ["la"], portland: ["pdx"], philadelphia: ["philly"], "new orleans": ["nola"], washington: ["dc"],
  "kansas city": ["kc"], "salt lake city": ["slc"], "las vegas": ["vegas"], chicago: ["chi"], austin: ["atx"],
};
const dropEnd = (ws: string[], drop: (w: string) => boolean) => {
  const out = [...ws];
  while (out.length > 1 && drop(out[out.length - 1])) out.pop();
  return out;
};
const dropStart = (ws: string[], drop: (w: string) => boolean) => {
  let i = 0;
  while (i < ws.length && drop(ws[i])) i++;
  return ws.slice(i);
};

// Where a candidate is, as words a person might type after its name. `aliases` name its city too.
function locationOf(e: Entity): { all: Set<string>; city: string[]; aliases: string[] } {
  const city = words(e.city ?? "");
  const region = words(e.region ?? "");
  const all = new Set([...city, ...region, ...words(e.country ?? "")]);
  const us = e.countryCode === "US" || e.countryCode === "CA";
  const code = us ? STATE_CODES[region.join(" ")] : undefined;
  if (code) all.add(code);
  const ap = us ? STATE_AP[region.join(" ")] : undefined;
  if (ap) all.add(ap);
  if (e.countryCode === "US") ["us", "usa"].forEach((w) => all.add(w));
  if (e.countryCode === "GB") all.add("uk");
  const aliases = us ? (CITY_ALIASES[city.join(" ")] ?? []) : [];
  aliases.forEach((w) => all.add(w));
  if (city.length) all.add("city"); // "New York City", "Mexico City"
  return { all, city, aliases };
}
// Words after a name that say nothing either way: a zip code, and "in" or "at" before the place ("House of
// Blues in Chicago"; a final "IN" is Indiana). Other numbers can be part of a name (Stage 48, Terminal 5).
const fillerAt = (rest: string[], i: number) => /^\d{5}(\d{4})?$/.test(rest[i]) || ((rest[i] === "in" || rest[i] === "at") && i < rest.length - 1);

// The rest of the typed words after the candidate's name, if its name opens them (compared without spaces).
function afterName(typed: string[], name: string[]): string[] | null {
  const target = name.join("");
  if (!target) return null;
  let acc = "";
  for (let k = 0; k < typed.length; k++) {
    acc += typed[k];
    if (acc === target) return typed.slice(k + 1);
    if (acc.length >= target.length || !target.startsWith(acc)) return null;
  }
  return null;
}

export function chooseVenue(input: string, found: Entity[]): { pick: Entity; exact: Entity[]; list: Entity[] } | null {
  const typed = words(input);
  // For near misses, only the words that name a room count: no location word of any candidate (some
  // records have no city) and no generic word, so "New York City Center" doesn't resemble "Bowery
  // Ballroom New York City".
  const anyPlace = new Set(found.flatMap((e) => [...locationOf(e).all]));
  const content = (ws: string[]) => ws.filter((w) => !anyPlace.has(w) && !GENERIC.has(w));
  const typedContent = content(typed);
  const place = (rest: string[]) => rest.filter((_, i) => !fillerAt(rest, i));

  // 1. How each candidate's name matches: in full, or without its generic ending; and what was typed after it.
  const matched = found.map((e, order) => {
    const loc = locationOf(e);
    const noData = !e.city && !e.region;
    // The city counts only from words outside the room's own name ("Mohawk" alone isn't in Mohawk, NY).
    const nameWords = new Set(dropEnd(words(e.name), (w) => loc.city.includes(w))); // "Mohawk Austin" names Mohawk
    const outside = typed.filter((w) => !nameWords.has(w));
    const inCity = loc.city.length > 0 && (loc.city.every((w) => outside.includes(w)) || loc.aliases.some((w) => outside.includes(w)));
    // After the name: nothing, its own location, or (a record with no location) any place word.
    const ownPlace = (rest: string[]) => {
      const p = place(rest);
      return p.length === 0 || (p.some((w) => w !== "city") && p.every((w) => loc.all.has(w) || (noData && anyPlace.has(w))));
    };
    const otherPlace = (rest: string[]) => place(rest).some((w) => w !== "city") && place(rest).every((w) => anyPlace.has(w));
    const raw = words(e.name);
    const named = [raw, dropEnd(raw, (w) => loc.city.includes(w))];
    let full = false, bare = false, bareAnywhere = false, elsewhere = false;
    for (const n of named) {
      const rest = afterName(typed, n);
      if (rest && ownPlace(rest)) full = true;
      else if (rest && otherPlace(rest)) elsewhere = true;
      // Without a generic ending ("Antone's" for Antone's Nightclub, "Red Rocks" for Red Rocks Amphitheatre).
      // A different typed ending ("Lincoln Hall" for Lincoln Theatre) never matches; a typed ending for a
      // record that has none ("Mohawk Bar") only where the place agrees.
      const b = dropEnd(n, (w) => GENERIC.has(w));
      const ending = n.slice(b.length);
      const bareRest = afterName(typed, b);
      if (!bareRest) continue;
      const after = dropStart(bareRest, (w) => GENERIC.has(w));
      const typedEnding = bareRest.slice(0, bareRest.length - after.length);
      const endingOk = typedEnding.length === 0 || (ending.length > 0 ? typedEnding.every((w) => ending.includes(w)) : inCity);
      if (!endingOk) continue;
      if (ownPlace(after)) bare = true;
      else if (otherPlace(after)) bareAnywhere = true;
    }
    // The same words in another order: "Fox Theatre, Tucson" is the Fox Tucson Theatre (a typed "city" must
    // be in the name: Rock City isn't The Rock).
    const said = place(typed);
    if (!full && raw.length && raw.every((w) => said.includes(w)) && said.every((w) => raw.includes(w) || (w !== "city" && loc.all.has(w)))) full = true;
    const near = content(raw);
    const closeness = typedContent.length && near.length ? (typedContent.filter((w) => near.includes(w)).length * 2) / (typedContent.length + near.length) : 0;
    const music = isMusic(e);
    // What was typed opens a longer name ("Red Rocks" for Red Rocks Park and Amphitheatre), and the rest is a place.
    let longerOwn = false, longerOther = false;
    for (let k = typed.length; k >= 1; k--)
      if (raw.length > k && typed.slice(0, k).every((w, i) => raw[i] === w)) {
        if (ownPlace(typed.slice(k))) longerOwn = true;
        else if (otherPlace(typed.slice(k))) longerOther = true;
      }
    return { e, order, inCity, full, bare, bareAnywhere, elsewhere, longerOwn, longerOther, closeness, resembles: wordsResemble(typedContent, near, false), music };
  });

  // 2. Where: the typed city, or its metro area (within 60 km of a candidate in the typed city: The Sinclair
  // in Cambridge for "Boston", the Turf Club in Saint Paul for "Minneapolis", Red Rocks for a Denver bar at
  // the airport, 50 km), from Qloo's coordinates.
  const centers = matched.filter((m) => m.inCity && m.e.lat !== undefined && m.e.lon !== undefined).map((m) => m.e as { lat: number; lon: number });
  const inArea = (e: Entity) => e.lat !== undefined && e.lon !== undefined && centers.some((c) => km(c, e as { lat: number; lon: number }) <= 60);

  // 3. Tiers: the full name in the city, then in the area; the name without its ending in the city or area;
  // the full name, then without the ending, where no other place was typed (or the record has none); the
  // full name in another place; near misses (the closest name first, then the typed place).
  const tiered = matched.map((m) => {
    const area = !m.inCity && inArea(m.e);
    const tier = m.full && m.inCity ? 0
      : (m.full || m.elsewhere) && area ? 1
      : m.bare && m.inCity ? 2
      : m.longerOwn && m.inCity ? 2.5 // "Rams Head, Annapolis" for Rams Head On Stage: in the city, not the exact name
      : (m.bare || m.bareAnywhere) && area ? 3
      : m.full ? 4
      : m.bare ? 5
      : m.elsewhere ? 6
      : m.resembles ? 7
      : 9;
    const located = typed.some((w) => w !== "city" && locationOf(m.e).all.has(w));
    return { ...m, tier, located };
  });
  // Rooms that match without their ending in the city or its area are peers ("Red Rocks, Denver": the bar in
  // Denver and the amphitheatre in Morrison), and a music venue comes first among them.
  const best = Math.min(9, ...tiered.map((t) => t.tier));
  if (best === 9) return null;
  // When the best match is a room without its ending that isn't a music venue (the Red Rocks Bar at the
  // Denver airport), a music venue whose name also opens with what was typed, and that the typed place
  // doesn't contradict, is a peer: Qloo's "Red Rocks Park and Amphitheatre" for "Red Rocks, Denver" or
  // "Red Rocks, CO". Then the answer is "several share this name", music venue first.
  const musicAtBest = tiered.some((t) => t.tier === best && t.music);
  const joins = (t: (typeof tiered)[number]) => t.music && t.tier > best && (t.bare || t.longerOwn || ((t.longerOther || t.bareAnywhere) && inArea(t.e)));
  if ([2, 3, 5].includes(best) && !musicAtBest) for (const t of tiered) if (joins(t)) t.tier = best;
  const peers = best === 2 && !musicAtBest ? [2, 3] : [best];
  const ranked = tiered
    .filter((t) => t.tier < 9)
    .sort((a, b) => {
      const peer = (t: typeof a) => peers.includes(t.tier) && (t.tier !== 3 || best === 3 || t.music);
      const pa = peer(a), pb = peer(b);
      if (pa !== pb) return pa ? -1 : 1;
      if (pa && pb && a.music !== b.music) return a.music ? -1 : 1;
      return a.tier - b.tier || (a.tier >= 6 ? b.closeness - a.closeness || Number(b.located) - Number(a.located) : 0) || Number(b.music) - Number(a.music) || a.order - b.order;
    });
  const exact = best <= 5 && best !== 2.5 ? ranked.filter((t) => peers.includes(t.tier) && (t.tier !== 3 || best === 3 || t.music)).map((t) => t.e) : [];
  return { pick: ranked[0].e, exact, list: ranked.map((t) => t.e) };
}

const label = (e: Entity) => (e.disambiguation && nameKey(e.disambiguation) !== nameKey(e.name) ? `${e.name} (${e.disambiguation})` : e.name);

// Artists: 5 candidates, like the harness.
export async function resolveArtist(q: Qloo, input: string): Promise<Resolved | null> {
  const found = (await q.search(input, "urn:entity:artist", 5)).filter((e) => e.types.includes("urn:entity:artist") || !e.types.length);
  const spaced = found.filter((e) => nameKey(e.name) === nameKey(input));
  const initials = (x: string) => words(x).some((w) => w.length === 1);
  const same = (e: Entity) => squashed(e.name) === squashed(input);
  const exact = spaced.length ? spaced : found.filter((e) => (initials(input) || initials(e.name)) && same(e));
  // Otherwise the same letters spaced differently are the closest match: "ACDC" for AC/DC, "boy genius" for
  // boygenius, ahead of other near names.
  const list = [...found.filter(same), ...found.filter((e) => !same(e))].filter((e) => exact.includes(e) || same(e) || resembles(input, e.name));
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
const NOT_ROOM = /\b(golf|country club|health club|fitness|gym|tennis|yacht|swim|athletic|sports club|museum)\b/i;
// A category that looks like a room but isn't one for shows; the place still counts by its other
// categories (the Texas Theatre is a movie theater and a performing arts theater; Red Rocks Cinema isn't).
const NOT_A_ROOM_CATEGORY = /\b(movie theat(er|re)|cinema)\b/i;
const MUSIC = /\b(live music|concert hall|music venue|jazz club|night ?club|amphitheat(er|re))\b/i;
// Some records have no category at all (live: "Red Rocks Park and Amphitheatre"); their name decides.
const ROOM_NAME = /\b(amphithea(tre|ter)|theat(re|er)|ballroom|music hall|concert hall|auditorium|arena|club|lounge|tavern|saloon|pub|bar)\b/i;
const MUSIC_NAME = /\b(amphithea(tre|ter)|ballroom|music hall|concert hall)\b/i;
export const isRoom = (e: Entity) => {
  const cats = e.categories ?? [];
  if (!cats.length) return ROOM_NAME.test(e.name) && !NOT_ROOM.test(e.name) && !NOT_A_ROOM_CATEGORY.test(e.name);
  return cats.some((c) => ROOM.test(c) && !NOT_A_ROOM_CATEGORY.test(c)) && (cats.some((c) => MUSIC.test(c)) || !cats.some((c) => NOT_ROOM.test(c)));
};
const isMusic = (e: Entity) => (e.categories?.length ? e.categories.some((c) => MUSIC.test(c)) : MUSIC_NAME.test(e.name));
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
