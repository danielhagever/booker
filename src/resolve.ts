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
// Accents are folded ("Beyonce" is Beyoncé); apostrophes, colons and dots join ("Cat's" is "Cats", "9:30"
// is "930"); other punctuation separates words.
const SPELLING: Record<string, string> = { theater: "theatre", amphitheater: "amphitheatre", centre: "center" };
const words = (s: string) =>
  normalizeName(s)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/['\u2018\u2019`:.]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => SPELLING[w] ?? w);
// "The Empty Bottle" and "Empty Bottle" are the same name; so are "Snail Mail" and "snail mail".
export const nameKey = (s: string) => words(s).join(" ");
// Without spaces, "S. G. Goodman" is S.G. Goodman; used only when no name is equal with its spaces, since
// Wild Child and Wildchild are different acts.
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
  }).map(([k, v]) => [k.split(" ").filter((w) => !STOP.has(w)).join(" "), v]),
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
  const scored = found.map((e, order) => {
    const loc = locationOf(e);
    const place = (rest: string[]) => rest.filter((_, i) => !fillerAt(rest, i));
    const isLoc = (rest: string[]) => place(rest).every((w) => loc.all.has(w)) && (place(rest).length === 0 || place(rest).some((w) => w !== "city"));
    const inCity = (rest: string[]) => loc.city.length > 0 && (loc.city.every((w) => rest.includes(w)) || loc.aliases.some((w) => rest.includes(w)));
    const raw = words(e.name);
    const named = [raw, dropEnd(raw, (w) => loc.city.includes(w))];
    let tier = 5;
    let elsewhere = false; // the name matches but the typed place is another candidate's ("Troubadour Los Angeles" for West Hollywood)
    for (const n of named) {
      const rest = afterName(typed, n);
      if (rest && isLoc(rest)) tier = Math.min(tier, inCity(rest) ? 0 : 2);
      else if (rest && place(rest).every((w) => anyPlace.has(w)) && place(rest).some((w) => w !== "city")) elsewhere = true;
      // Without a generic ending: only if what was typed in its place is one of the record's own
      // ("Antone's" for Antone's Nightclub, "Red Rocks" for Red Rocks Amphitheatre), not another kind of
      // room ("Lincoln Hall" isn't Lincoln Theatre, "Fillmore Auditorium" isn't The Fillmore).
      const bare = dropEnd(n, (w) => GENERIC.has(w));
      const ending = n.slice(bare.length);
      const bareRest = afterName(typed, bare);
      const typedEnding = bareRest ? bareRest.slice(0, bareRest.length - dropStart(bareRest, (w) => GENERIC.has(w)).length) : [];
      const after = bareRest && dropStart(bareRest, (w) => GENERIC.has(w));
      if (after && (ending.length === 0 || typedEnding.every((w) => ending.includes(w))) && isLoc(after)) tier = Math.min(tier, inCity(after) ? 1 : 3);
    }
    // The same words in another order: "Fox Theatre, Tucson" is the Fox Tucson Theatre. A typed "city" must
    // be in the name here (Rock City isn't The Rock).
    if (tier === 5) {
      const said = place(typed);
      if (raw.length && raw.every((w) => said.includes(w)) && said.every((w) => raw.includes(w) || (w !== "city" && loc.all.has(w)))) tier = inCity(said) ? 0 : 2;
    }
    // Near misses that sit where the typed place says come first.
    const located = typed.some((w) => w !== "city" && loc.all.has(w));
    const near = content(raw);
    const closeness = elsewhere ? 2 : typedContent.length && near.length ? (typedContent.filter((w) => near.includes(w)).length * 2) / (typedContent.length + near.length) : 0;
    if (tier === 5 && (elsewhere || wordsResemble(typedContent, near, false))) tier = 4;
    const music = (e.categories ?? []).some((c) => MUSIC.test(c));
    return { e, tier, closeness, located, music, order };
  });
  // Best tier first; among near misses the one in the typed place, then the closest name; then music
  // venues; then Qloo's order.
  const ranked = scored
    .filter((x) => x.tier < 5)
    .sort((a, b) => a.tier - b.tier || (a.tier === 4 ? Number(b.located) - Number(a.located) || b.closeness - a.closeness : 0) || Number(b.music) - Number(a.music) || a.order - b.order);
  if (!ranked.length) return null;
  const best = ranked[0].tier;
  const exact = best < 4 ? ranked.filter((x) => x.tier === best).map((x) => x.e) : [];
  return { pick: ranked[0].e, exact, list: ranked.map((x) => x.e) };
}

const label = (e: Entity) => (e.disambiguation && nameKey(e.disambiguation) !== nameKey(e.name) ? `${e.name} (${e.disambiguation})` : e.name);

// Artists: 5 candidates, like the harness.
export async function resolveArtist(q: Qloo, input: string): Promise<Resolved | null> {
  const found = (await q.search(input, "urn:entity:artist", 5)).filter((e) => e.types.includes("urn:entity:artist") || !e.types.length);
  const spaced = found.filter((e) => nameKey(e.name) === nameKey(input));
  const exact = spaced.length ? spaced : found.filter((e) => squashed(e.name) === squashed(input));
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
