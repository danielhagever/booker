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
const SPELLING: Record<string, string> = { theater: "theatre", amphitheater: "amphitheatre", centre: "center", ave: "avenue", blvd: "boulevard" };
// Letters written as signs read as letters: P!nk is Pink (between consonants only: GO!GO!7188 is "go go"),
// Ke$ha is Kesha, Joey Bada$$ is Badass, $uicideboy$ is Suicideboys.
const allWords = (s: string) =>
  normalizeName(s)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u00f8\u00e6\u0153\u00df\u0142\u0111\u00fe]/g, (c) => FOLD[c])
    .replace(/(?<=[b-df-hj-np-tv-z])!(?=[b-df-hj-np-tv-z])/g, "i")
    .replace(/\$+(?=\p{L})|(?<=\p{L})\$+/gu, (m) => "s".repeat(m.length))
    .replace(/[&+]/g, " and ") // "Florence + the Machine", "Simon & Garfunkel"
    .replace(/['\u2018\u2019`:.]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SPELLING[w] ?? w);
// "A" before an initial is an initial too: "A. R. Rahman", "A G Cook".
const article = (s: string, ws: string[]) => ws.length > 1 && ARTICLES.has(ws[0]) && !(ws[0] === "a" && (/^\s*a\./i.test(s) || ws[1].length === 1));
const words = (s: string) => {
  const ws = allWords(s);
  return article(s, ws) ? ws.slice(1) : ws;
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

// Small words don't make two names alike ("of", "the", "and", "de", "la").
const SMALL = new Set(["of", "the", "and", "a", "an", "de", "la", "le", "el", "los", "las", "y", "et", "und", "der", "die", "das", "du", "des", "n"]);
// Words written two ways count as close, not equal ("Hank Williams 3" is close to Hank Williams III, "Maroon
// Five" to Maroon 5), so that initials still compare without spaces ("J. R. Writer" is J.R. Writer); so does a
// plural of a short word ("Fleet Fox" is Fleet Foxes).
const TWINS = [["1", "one"], ["2", "ii", "two"], ["3", "iii", "three"], ["4", "iv", "four"], ["5", "five"], ["6", "six"], ["7", "seven"], ["8", "eight"], ["9", "nine"], ["10", "ten"], ["20", "twenty"], ["jr", "junior"]];
const TWIN = new Map(TWINS.flatMap((g, i) => g.map((w) => [w, i] as const)));
const twins = (a: string, b: string) => TWIN.has(a) && TWIN.get(a) === TWIN.get(b);
const plural = (a: string, b: string) => [a, b].some((x) => x.length >= 3 && [`${x}s`, `${x}es`].includes(x === a ? b : a));
const closeTo = (w: string, b: string[], plurals = true) => b.some((x) => x === w || twins(w, x) || (plurals && plural(w, x)) || typoDistance(w, x) <= (w.length > 5 ? 2 : w.length > 3 ? 1 : 0));
// The share of a's words, small words aside, that are close to some word of b. Plurals of words of three
// letters or more count between names of as many words: "Fleet Fox" is close to Fleet Foxes and "The Car" to
// The Cars, but "Boy" isn't to Boys Noize.
function share(a: string[], b: string[], withPlurals = true): number {
  const keep = (ws: string[]) => (ws.some((w) => !SMALL.has(w)) ? ws.filter((w) => !SMALL.has(w)) : ws);
  const ca = keep(a), cb = keep(b);
  const plurals = withPlurals && ca.length === cb.length;
  return ca.length ? ca.filter((w) => closeTo(w, cb, plurals)).length / ca.length : 0;
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
  minneapolis: ["mpls"], "saint louis": ["stl"], "st louis": ["stl"],
};
// Cities Qloo files separately that people type as the big city next door: "Troubadour, Los Angeles" is in
// West Hollywood, "Crystal Ballroom, Boston" in Somerville, "Cat's Cradle, Chapel Hill" in Carrboro.
// Each with its state: Aurora, Illinois isn't Denver's Aurora, nor Hollywood, Florida LA's.
const METRO: Record<string, string[]> = {
  "los angeles": ["west hollywood|california", "hollywood|california", "north hollywood|california", "santa monica|california", "pasadena|california", "burbank|california", "glendale|california", "inglewood|california", "culver city|california", "long beach|california"],
  "new york": ["brooklyn|new york", "queens|new york", "bronx|new york", "manhattan|new york", "long island city|new york", "jersey city|new jersey", "hoboken|new jersey"],
  boston: ["cambridge|massachusetts", "somerville|massachusetts", "allston|massachusetts", "brookline|massachusetts", "medford|massachusetts"],
  "san francisco": ["oakland|california", "berkeley|california"],
  minneapolis: ["saint paul|minnesota", "st paul|minnesota"],
  denver: ["morrison|colorado", "englewood|colorado", "aurora|colorado", "lakewood|colorado"],
  washington: ["arlington|virginia", "alexandria|virginia", "silver spring|maryland", "bethesda|maryland"],
  chicago: ["evanston|illinois", "cicero|illinois", "berwyn|illinois"],
  philadelphia: ["camden|new jersey"],
  atlanta: ["decatur|georgia"],
  miami: ["miami beach|florida"],
  detroit: ["ferndale|michigan", "royal oak|michigan", "hamtramck|michigan"],
  phoenix: ["tempe|arizona", "scottsdale|arizona", "mesa|arizona"],
  "chapel hill": ["carrboro|north carolina"],
};
const NEXT_TO = new Map(Object.entries(METRO).flatMap(([core, near]) => near.map((c) => [c.split("|").map((x) => words(x).join(" ")).join("|"), core] as const)));
// Australian states as people abbreviate them ("Corner Hotel, Melbourne VIC").
const AU_STATES: Record<string, string> = {
  victoria: "vic", "new south wales": "nsw", queensland: "qld", "western australia": "wa", "south australia": "sa", tasmania: "tas",
  "australian capital territory": "act", "northern territory": "nt",
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
// `places` are its places as whole phrases (city, state, codes, nicknames, the big city next door) and `countries`
// its country's names and codes, for telling when a place was typed in full ("Mexico City", not just "Mexico").
function locationOf(e: Entity): { all: Set<string>; city: string[]; aliases: string[]; places: string[][]; countries: string[][] } {
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
  // Elsewhere the country's two-letter code ("Lido, Berlin, DE"; a US state code stays the state's) and an
  // Australian state's abbreviation.
  else if (e.countryCode && !us) all.add(e.countryCode.toLowerCase());
  if (e.countryCode === "AU" && AU_STATES[region.join(" ")]) all.add(AU_STATES[region.join(" ")]);
  const aliases = us ? (CITY_ALIASES[city.join(" ")] ?? []) : [];
  aliases.forEach((w) => all.add(w));
  // The big city next door, with its nicknames ("Troubadour, LA").
  const core = us ? NEXT_TO.get(`${city.join(" ")}|${region.join(" ")}`) : undefined;
  if (core) [...words(core), ...(CITY_ALIASES[core] ?? [])].forEach((w) => all.add(w));
  if (city.length) all.add("city"); // "New York City", "Mexico City"
  const one = (w?: string) => (w ? [[w]] : []);
  const places = [city, region, ...one(code), ...one(ap), ...aliases.map((a) => [a]), ...one(e.countryCode === "AU" ? AU_STATES[region.join(" ")] : undefined),
    ...(core ? [words(core), ...(CITY_ALIASES[core] ?? []).map((a) => [a])] : [])].filter((p) => p.length);
  const countries = [words(e.country ?? ""), ...(e.countryCode === "US" ? [["us"], ["usa"]] : e.countryCode === "GB" ? [["uk"]] : e.countryCode && !us ? [[e.countryCode.toLowerCase()]] : [])].filter((p) => p.length);
  return { all, city, aliases, places, countries };
}
// Words after a name that say nothing either way: a zip code, and "in" or "at" before the place ("House of
// Blues in Chicago"; a final "IN" is Indiana). Other numbers can be part of a name (Stage 48, Terminal 5).
// Shortened words in place names ("N Hollywood", "So Burlington", "Mt Vernon", "Ft Worth", "St Louis").
const PLACE_ABBR: Record<string, string[]> = {
  n: ["north", "northern"], no: ["north"], s: ["south", "southern"], so: ["south"], e: ["east", "eastern"], w: ["west", "western"],
  mt: ["mount"], ft: ["fort"], st: ["saint"], ste: ["sainte"],
};
// (In chooseVenue, "IN" is the state when it opens a part after a comma and the US follows ("Kirkwood Ave, IN,
// USA"), before an Indiana zip ("IN 46220"), or at the end; "in USA", "in 37215", "The Palladium, in UK" and "The
// Bluebird, in Nashville" still connect.)
const ZIP = /^\d{5}(\d{4})?$/;
const US_AFTER = new Set(["us", "usa", "america", "united"]); // "IN, United States"; not "IN, Canada" or "in UK"
const fillerAt = (rest: string[], i: number) => ZIP.test(rest[i]) || ((rest[i] === "in" || rest[i] === "at" || rest[i] === "the") && i < rest.length - 1);

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
  // Where the typed words were separated by a comma (a full-width one too): a place's words never span one
  // ("Fuller St, Helena"). New lines never get here: the input is cleaned to single spaces first.
  const BREAK = "zqxbreakzq";
  const commaAt = new Set<number>();
  {
    let k = 0;
    const marked = words(input.normalize("NFKC").replace(/,/g, ` ${BREAK} `));
    for (const w of marked) w === BREAK ? commaAt.add(k) : k++;
    if (k !== typed.length) commaAt.clear();
  }
  // For near misses, only the words that name a room count: no location word of any candidate (some
  // records have no city) and no generic word, so "New York City Center" doesn't resemble "Bowery
  // Ballroom New York City".
  const anyPlace = new Set(found.flatMap((e) => [...locationOf(e).all]));
  const content = (ws: string[]) => ws.filter((w) => !anyPlace.has(w) && !GENERIC.has(w));
  const typedContent = content(typed);
  const filler = (rest: string[], i: number) => {
    const at = typed.length - rest.length + i; // rest is always the end of what was typed
    const next = rest[i + 1] ?? "";
    if (rest[i] === "in" && ((commaAt.has(at) && US_AFTER.has(next) && (next !== "united" || rest[i + 2] === "states")) || /^4[67]\d{3}$/.test(next))) return false;
    return fillerAt(rest, i);
  };
  const place = (rest: string[]) => rest.filter((_, i) => !filler(rest, i));

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
    // The name, without its city at the end ("Mohawk Austin" is Mohawk), and without its state or nickname
    // when a real name is left ("Billy Bob's Texas" is Billy Bob's, in Fort Worth; "Club Texas" isn't Club).
    const unplaced = dropEnd(raw, (w) => w !== "city" && loc.all.has(w));
    const named = [raw, dropEnd(raw, (w) => loc.city.includes(w)), ...(unplaced.some((w) => !GENERIC.has(w) && !SMALL.has(w)) ? [unplaced] : [])];
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
    // The name opens what was typed and the rest names no other candidate's place: a neighborhood or a street
    // ("Mohawk, East Austin", "The Lexington, Islington", "Mohawk on Red River"). A closest match, better
    // when the rest also holds the room's own city.
    // Not when the next typed word is a typo of how another candidate's longer name goes on ("Thalia Hal" is
    // Thalia Hall, not the bar Thalia; "Lodge Rom" is Lodge Room, not The Lodge).
    let opens = 0;
    for (const n of named) {
      const rest = afterName(typed, n);
      if (!rest || !place(rest).length || !place(rest).every((w) => !anyPlace.has(w) || loc.all.has(w))) continue;
      // Short or small words are passed over on both sides and the first real word after them must be close:
      // "Music Hall of Wiliamsburg" and "Music Hall in Williamsburg" are Music Hall of Williamsburg, but "The
      // Music Hall on Chestnut" isn't, nor is "Hard Rock Live at Universal" Hard Rock Live at Etess Arena.
      const minor = (w: string) => w.length < 3 || SMALL.has(w);
      const skip = (ws: string[], from: number) => { let k = from; while (k < ws.length && minor(ws[k])) k++; return k; };
      // Close: equal, cut off, one letter off, or two in a word of four letters or more ("Blews", "Pear 57",
      // "Wiliamsberg"). Only short words typed
      // ("Music Hall of", "City Winery at Pi"): they must open the longer name's next words. A longer name that goes
      // on with its own place ("House of Blues Las Vegas" for "House of Blues LA", "House of Blues Boston" for
      // "Huston") is a location, which the rules above already weigh.
      const k = skip(rest, 0);
      const goesOn = found.some((o) => {
        const w = words(o.name);
        if (o === e || w.length <= n.length || !n.every((x, i) => w[i] === x)) return false;
        const own = locationOf(o).all;
        if (k >= rest.length) return !own.has(w[n.length]) && rest.every((x, i) => { const y = w[n.length + i]; return y !== undefined && (y === x || (i === rest.length - 1 && y.startsWith(x))); });
        const j = skip(w, n.length);
        if (j >= w.length || own.has(w[j])) return false;
        const t = rest[k], next = w[j], d = typoDistance(t, next);
        return next === t || next.startsWith(t) || d <= (t.length >= 4 ? 2 : 1);
      });
      if (goesOn) continue;
      // Better with the room's own place typed (its city, state or nickname), best exactly; a cut-off of three
      // letters or more or a misspelling counts too ("Brooklyn Bowl Phila", "City Winery ATL", "House of Blues
      // Hueston", "Billy Bob's Texs"), as goesOn's closeness ("LA" isn't cut-off Las Vegas); one letter off before
      // two ("Huston" is Houston, not Boston).
      const placed = place(rest);
      const said = placed.filter((w) => w !== "city");
      // A place typed in full, its words together and not across a comma: the room's own ("Mexico City",
      // "Northern Ireland") or its country; a direction or title may be shortened ("N Ireland", "W Virginia", "Mt
      // Vernon", "St Paul"; but "1354 W Wabansia Ave, Chicago" isn't West Chicago, "Fuller St, Helena" isn't
      // Saint Helena).
      const base = typed.length - rest.length;
      const typedIn = (ph: string[]) =>
        rest.some((_, j) => ph.every((w, m) => { const t = rest[j + m]; return t !== undefined && (!filler(rest, j + m) || (ph.length > 1 && t === w)) && (t === w || PLACE_ABBR[t]?.includes(w)) && (m === 0 || !commaAt.has(base + j + m)); }));
      // How far a typed word is from the room's place. Its own city (words of four letters or more): 1 when cut off
      // ("Phila", "ATL", "Det", also before a neighborhood) or one letter off in a word of four letters or more
      // ("Pual", "Rneo"; "End" isn't Bend). Its other place words of four letters or more: its state, the big city
      // next door, a nickname: 1 when it's the last word typed and opens one ("Bos", "Wisc", "Cali"; "Penn Quarter"
      // isn't Pennsylvania) or one letter off where either word has five letters or more ("Phily", "Renno"; "NoDa"
      // isn't NOLA). For either, 2 when two letters off in a word of six letters or more ("Hueston"; "East",
      // "Soho", "Park" aren't Mass, Ohio, York); 3 when it's one word of a longer place ("Mexico" of New Mexico,
      // "Ireland" of Northern Ireland). Else too far.
      const cityWords = loc.city.filter((p) => p.length >= 4);
      const country = new Set(loc.countries.flat());
      const others = [...loc.all].filter((p) => p !== "city" && p.length >= 4 && !country.has(p) && !cityWords.includes(p));
      const countryWords = [...country].filter((p) => p.length >= 4);
      const off = (w: string, i: number) => {
        if (w.length < 3) return 9;
        const last = i === said.length - 1;
        const near = (p: string, cutAnywhere: boolean, short: boolean) => {
          if (w === p) return 3;
          if ((cutAnywhere || last) && p.startsWith(w)) return 1;
          const d = typoDistance(w, p);
          return d <= 1 && (short ? w.length >= 4 : Math.max(w.length, p.length) >= 5) ? d : d === 2 && w.length >= 6 ? 2 : 9;
        };
        return Math.min(9, ...cityWords.map((p) => near(p, true, true)), ...others.map((p) => near(p, false, false)));
      };
      // A country, exact or as the last word cut off or one letter off ("Aus", "Austrailia"; never two letters off:
      // "Island" isn't Ireland), only tells rooms of different countries apart: after any sign of the room's own
      // city or state ("State Theatre, Syd, Aus" or "Syd, AU" is Sydney, not Melbourne; "Paramount Theatre, Aus"
      // Austin first). (A room in another country never gets here: the country typed is another room's place.)
      const countryNear = (w: string, i: number) =>
        i === said.length - 1 && w.length >= 3 && countryWords.some((p) => p.startsWith(w) || (typoDistance(w, p) <= 1 && Math.max(w.length, p.length) >= 5));
      const nearest = Math.min(9, ...said.map((w, i) => off(w, i)));
      // The more of what was typed a place covers, the better: "N Hollywood" is North Hollywood before Hollywood.
      const full = loc.places.filter(typedIn);
      const tierHere = full.length ? 6.3 - Math.max(...full.map((ph) => ph.length)) / 1000 : nearest === 1 ? 6.4 : nearest === 2 ? 6.5
        : loc.countries.some(typedIn) ? 6.53 : nearest === 3 ? 6.55 : said.some(countryNear) ? 6.56 : 6.6;
      opens = opens ? Math.min(opens, tierHere) : tierHere;
    }
    return { e, order, inCity, full, bare, bareAnywhere, elsewhere, longerOwn, longerOther, opens, closeness, resembles: wordsResemble(typedContent, near, false), music };
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
      // 6.3 own place, 6.4 cut off or one letter off, 6.5 two letters off, 6.53 its country, 6.55 one word of a
      // longer place, 6.56 the country misspelled, 6.6 nothing of its place.
      : m.opens ? m.opens
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
const SPARE_FOR_NAMES = 20;

export async function resolveArtist(q: Qloo, input: string, spare = SPARE_FOR_NAMES): Promise<Resolved | null> {
  const artists = (found: Entity[]) => found.filter((e) => e.types.includes("urn:entity:artist") || !e.types.length);
  const found = artists(await q.search(forSearch(input), "urn:entity:artist", 5));
  let r = rankNames(found, input);
  // With a note in brackets, the name alone is searched too when that may find a better entry (see Ranked), but
  // only while the request has calls to spare: 8 acts and 8 pitches, each with a note, would otherwise take 16
  // more and leave the rest of the search none (measured: 48 of 48, and a single retry then failed it).
  if (withoutNote(input) !== input && (!r || r.searchName) && q.budget.left() > spare) r = rankNames(together(found, artists(await q.search(withoutNote(input), "urn:entity:artist", 5))), input);
  if (!r) return null;
  return {
    input,
    entity: r.pick,
    match: r.match,
    // Qloo's search gives artists no genres, so a same-named act is told apart by its popularity.
    alternatives: r.list.filter((e) => e.id !== r.pick.id && r.offered(e)).slice(0, 4).map((e) => ({ id: e.id, name: label(e), note: e.genres?.[0] ?? (e.popularity !== undefined ? `popularity ${e.popularity.toFixed(2)}` : undefined) })),
  };
}

// A note in brackets at the end is how an agent or a person says which one. It is read in this order (Qloo's
// live answers for 205 such inputs are recorded in test/note-fixtures.json):
// - a title holding both the name and every word of the note that isn't already in the name or a kind word, each
//   as written, as a number in another form ("5", "V", "Five") or as a short form ("Pt. II", "Vol. 3"), in either
//   order ("Star Wars (The Empire Strikes Back)" is Episode V; "Parts Unknown (Anthony Bourdain)" is Anthony
//   Bourdain: Parts Unknown; "Batman (movie)" is not Batman: The Movie, "Interstellar (Nolan)" not Interstellar:
//   Nolan's Odyssey). Not for acts: an act holding both names is a collaboration ("Mos Def (Yasiin Bey & Marvin Gaye)");
// - the note as the exact name of one title ("Indiana Jones (Raiders of the Lost Ark)", "La Casa de Papel (Money
//   Heist)"), for a name of two words or more, not all kind words ("Game of Thrones" counts), and
//   never for an act: an act's note is as often a hometown that is also a band's name ("Moonsprout (New England)"),
//   so "Ye (Kanye West)" is not found rather than guessed;
// - when an entry is named exactly the name (or one letter off, two in a long name: "Better Call Saull"), it wins
//   over a title named in the note, which is offered first under "Not it?" ("Better Call Saul (Breaking Bad)",
//   "Chicago P.D. (Chicago Fire)", so also "Fast & Furious (Fast Five)" is the 2009 film); and a title must continue
//   the name after a separator, a linking word or a number ("Star Wars: Episode V", "The Fast and the Furious: Tokyo
//   Drift", "Harry Potter and the...", "The Godfather Part II"), or start with the note that way and hold the name
//   ("Furiosa: A Mad Max Saga", "The Lost World: Jurassic Park", "War for the Planet of the Apes"): "The Mandalorian
//   (Star Wars)" is not Lego Star Wars: The Mandalorian, and "Amy (Winehouse documentary)" is not Amy Winehouse. A
//   note holding the whole name plus words is a fuller name, not a subtitle ("Amy (Amy Winehouse)" is Amy, 2015),
//   unless it adds a number ("Toy Story (Toy Story 3)", "(The Hunger Games: Mockingjay Part 1)"). Linking words
//   ("to", "in", "presents") and part words ("Part", "Vol.") are skipped: "Back to the Future (Part 2)" is Back to
//   the Future Part II, "Toy Story (Part 3)" Toy Story 3, "Fast & Furious (Hobbs & Shaw)" Fast & Furious Presents:
//   Hobbs & Shaw. A franchise's own words may come before the separator ("Twilight (New Moon)" is The Twilight
//   Saga: New Moon), the title holding more of the note's words wins ("Star Wars (Episode 1)" is Episode I, not
//   Rogue One), and kind words in the note hide nothing ("SpongeBob (movie)" is The SpongeBob SquarePants Movie).
//   A note that is only a number asks for the Nth: the title with that number right after the name ("Shrek (2)" is
//   Shrek 2); else Qloo's own top answer when it carries no number and belongs to the series ("Mad Max (2)" is The
//   Road Warrior); else the Nth by year of the titles starting with the name, from the one named exactly that,
//   titles numbered otherwise left out ("The Hunger Games (2)" is Catching Fire, not Mockingjay - Part 2). On a TV
//   show a number or a season is a season of the show ("Skins (series 2)", "Squid Game (Season 2)" are the shows,
//   not a making-of special); a title holding the name and the number also counts ("2 Fast 2 Furious"). Known limit: an
//   unrelated title that reads as a sequel wins ("Alien (2)" is Alien 2: On Earth, a 1980 film, not Aliens). Kind words at the end of a note only say what it is ("(Raiders of the Lost Ark film)"). A title holding the
//   name and the note that isn't taken is offered first under "Not it?", and otherwise only entries holding the
//   name are offered ("Dune (Part Two)" isn't offered The Godfather Part II);
// - "aka" before the note says it's another name, so then an act may take it too ("Ye (aka Kanye West)");
// - the name alone, among entries that don't hold the note's words; a year in the note picks among the near names
//   holding the whole name, by Qloo's disambiguation ("Dune (2021 film)"; "The Lord of the Rings (2001)" is The
//   Fellowship of the Ring; "Spider-Man (2002 film)" is not Spider (2002)); "Dune (Part One)" is Dune, not Dune:
//   Part Two; a note of kind words is set aside ("Wednesday (band)" is not The Band).
// The note's words never make a match on their own ("Scream: The TV Series" for "Succession (TV series)", live),
// and the pick is only a closest match, since what was typed wasn't a name. A whole text that is exactly a name
// ("Birdman (or The Unexpected Virtue of Ignorance)") is that name.
const NOTE = /\s*[([]([^()[\]]*)[)\]]\s*$/;
// Qloo's search finds "Star Wars (Episode 1)" but not "Star Wars (Episode One)": a number word after a part word
// in the note is searched as a digit (matching still reads what was typed).
const SPELLED = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export const forSearch = (s: string) =>
  s.replace(NOTE, (note) => note.replace(/\b(part|pt\.?|episode|ep\.?|vol\.?|volume|chapter|ch\.?)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (_, p: string, n: string) => `${p} ${SPELLED.indexOf(n.toLowerCase()) + 1}`));
export const withoutNote = (s: string) => {
  const note = NOTE.exec(s);
  return (note && s.slice(0, note.index).trim()) || s;
};

export interface Ranked {
  pick: Entity;
  match: "exact" | "ambiguous" | "closest";
  list: Entity[]; // every near name, best first
  offered: (e: Entity) => boolean; // close enough to offer under "Not it?"
  note?: "title" | "year" | "name" | "other name"; // how a note in brackets was read
  // Qloo is searched with the whole text first; the name alone is searched too when nothing matched, when the
  // name matched only loosely ("The Godfather (Part I)" found only Part II and III), when the note's year wasn't
  // among the entries ("Dune (2021 film)" found only the 1984 film), or before a pick the name itself may beat.
  searchName?: boolean;
}

// The candidates Qloo's search returned for what was typed, ranked; null when none resembles it.
// Words that only say what kind of thing it is; a note made of them (and years) is never another name ("Wednesday
// (band)" is not The Band).
const KIND = new Set("band group rapper singer songwriter musician artist act dj producer duo trio composer film movie series show tv sitcom documentary docuseries miniseries anime cartoon podcast book novel game album song".split(" "));
const LINKS = new Set(["for", "from", "to", "in", "on", "at", "with", "vs", "versus", "presents"]);
// Words that mark a sequel or a part ("Vol. 3", "Part II").
const PART = new Set(["part", "pt", "vol", "volume", "episode", "ep", "chapter", "ch", "season"]);
// "aka" before a note says it's another name.
const AKA = /^\s*(?:a\.?\s?k\.?\s?a\.?|also known as|known as)\s+/i;
// What comes right after the given words at the start of a title: a separator (":", "-"), a linking word ("and the",
// "of the"), a number or part word, another word, or nothing; null when the title doesn't start with those words.
function after(title: string, given: string[]): "sep" | "link" | "number" | "word" | "end" | null {
  const ws = given.filter((w) => !SMALL.has(w) && !LINKS.has(w)); // "Back to the Future" is back, future
  const tokens = title.match(/[^\s:\u2013\u2014-]+|[:\u2013\u2014-]/g) ?? [];
  let k = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (/^[:\u2013\u2014-]$/.test(tokens[i])) {
      if (k === ws.length) return "sep";
      continue;
    }
    for (const w of words(tokens[i])) {
      if (k === ws.length) return SMALL.has(w) || LINKS.has(w) ? "link" : NUMBER.has(w) || PART.has(w) ? "number" : "word";
      if (SMALL.has(w) || LINKS.has(w)) continue;
      if (!sameWord(ws[k], w)) return null;
      k++;
    }
  }
  return k === ws.length ? "end" : null;
}
// The words of a title after the given words at its start, separators left out; null when it doesn't start with them.
function wordsAfter(title: string, given: string[]): string[] | null {
  const ws = given.filter((w) => !SMALL.has(w) && !LINKS.has(w));
  const rest: string[] = [];
  let k = 0;
  for (const token of title.match(/[^\s:\u2013\u2014-]+/g) ?? [])
    for (const w of words(token)) {
      if (k < ws.length) {
        if (SMALL.has(w) || LINKS.has(w)) continue;
        if (!sameWord(ws[k], w)) return null;
        k++;
      } else rest.push(w);
    }
  return k === ws.length ? rest : null;
}
// Kind words at the end of a note only say what it is ("Raiders of the Lost Ark film").
function trimKind(s: string): string {
  let t = s.trim();
  for (let m = /^(.*\S)\s+(\S+)$/.exec(t); m && words(m[2]).length && words(m[2]).every((w) => KIND.has(w)); m = /^(.*\S)\s+(\S+)$/.exec(t)) t = m[1];
  return t;
}
const yearOf = (e: Entity) => Number(years(e.disambiguation)[0] ?? NaN);
const years = (s: string | undefined): string[] => s?.match(/\b\d{4}\b/g) ?? [];
// In a title, a note's word must be there as written, or as its number twin ("2", "II", "Two") or short form.
const SHORT: Record<string, string> = { pt: "part", vol: "volume", ep: "episode", ch: "chapter" };
const NUMBER = new Map("1 i one,2 ii two,3 iii three,4 iv four,5 v five,6 vi six,7 vii seven,8 viii eight,9 ix nine,10 x ten".split(",").flatMap((g, i) => g.split(" ").map((w) => [w, i] as const)));
const sameWord = (a: string, b: string) => a === b || (NUMBER.has(a) && NUMBER.get(a) === NUMBER.get(b)) || (SHORT[a] ?? a) === (SHORT[b] ?? b);

export function rankNames(found: Entity[], input: string): Ranked | null {
  const all = rankTyped(found, input);
  const bare = withoutNote(input);
  if (bare === input) return all;
  const named = words(bare).filter((w) => !SMALL.has(w));
  // With a note, "Not it?" offers only entries holding the name, besides the note's own titles ("Dune (Part Two)" isn't
  // offered The Godfather Part II, which shares "part two").
  const holdsName = (e: Entity) => named.every((w) => closeTo(w, words(e.name), false));
  if (all?.match === "exact") return { ...all, offered: (e) => all.offered(e) && holdsName(e) };
  const aka = AKA.exec(NOTE.exec(input)![1]);
  const rawNote = NOTE.exec(input)![1].slice(aka?.[0].length ?? 0).trim();
  const noted = trimKind(rawNote);
  // The note's words that aren't already in the name ("Chance the Rapper (rapper)" adds nothing).
  const told = words(noted).filter((w) => !SMALL.has(w) && !closeTo(w, named, false));
  const holds = (e: Entity, ws: string[]) => !!ws.length && ws.every((w) => closeTo(w, words(e.name), false));
  // Kind words don't make an entry the note's ("SpongeBob (movie)" keeps The SpongeBob Movie).
  const holdsNote = (e: Entity) => holds(e, told.filter((w) => !KIND.has(w)));
  const isArtist = (e: Entity) => e.types.includes("urn:entity:artist");
  // The name alone, among entries that don't hold the note's words.
  const r = rankTyped(found.filter((e) => !holdsNote(e)), bare);
  // When an entry is named exactly the name (see the header), it wins over a title named in the note, and a title
  // must continue the name or start with the note (below).
  // A name one letter off (two in a long name) counts as named too ("Better Call Saull (Breaking Bad)" is still
  // Better Call Saul).
  const named_ = !!r && (r.match !== "closest" || typoDistance(squashed(r.pick.name), squashed(bare)) <= (squashed(bare).length > 10 ? 2 : 1));
  const noteWords = words(noted).filter((w) => !SMALL.has(w));
  // A note holding the whole name and adding words is a fuller name ("Whitney (Whitney Houston)", "Amy (Amy
  // Winehouse)"), not a subtitle; adding a number, it's a sequel ("Toy Story (Toy Story 3)", "The Hunger
  // Games (The Hunger Games: Mockingjay Part 1)").
  const fuller = named.every((w) => noteWords.some((x) => sameWord(w, x))) && !told.some((w) => NUMBER.has(w));
  // A title must hold the note's words that aren't kind words ("Batman (movie)" is not Batman: The Movie).
  // Part words only mark the number ("Toy Story (Part 3)" is Toy Story 3).
  const titleWords = told.filter((w) => !KIND.has(w) && !PART.has(w));
  const holdsExactly = (e: Entity, ws: string[]) => !!ws.length && ws.every((w) => words(e.name).some((x) => sameWord(w, x)));
  // Linking words don't count in a title ("War for the Planet of the Apes").
  // Next to an entry named exactly the name, a title must continue the name after a separator, a linking word or a
  // number ("Star Wars: Episode V", "Harry Potter and the Prisoner of Azkaban", "The Godfather Part II"), or start
  // with the note that way and hold the name ("Furiosa: A Mad Max Saga", "Rise of the Planet of the Apes"); a title
  // running the name straight on is another name ("Amy Winehouse" for "Amy (Winehouse documentary)").
  const noteLead = noteWords.filter((w) => !LINKS.has(w));
  const subtitle = (e: Entity) => ["sep", "link", "number"].includes(after(e.name, named) ?? "");
  const spinOff = (e: Entity) => ["sep", "link"].includes(after(e.name, noteLead) ?? "");
  // Or the name, then a franchise's own words, then a separator, then the note ("The Twilight Saga: New Moon").
  const franchise = (e: Entity) => {
    const cut = e.name.search(/\s*[:\u2013\u2014]\s*|\s+-\s+/);
    return cut > 0 && holdsExactly({ ...e, name: e.name.slice(0, cut) }, named) && after(e.name.slice(cut).replace(/^\s*[:\u2013\u2014-]\s*/, ""), noteLead) !== null;
  };
  const startsWithName = (e: Entity) => after(e.name, named) !== null;
  // A note that is only a number ("The Hunger Games (2)", "Frozen (Part 2)") asks for the Nth film: the title
  // numbered that way right after the name ("Shrek 2", "Kill Bill: Vol. 2", "The Lord of the Rings: The Two
  // Towers"); else Qloo's own top answer for "Name (N)", when it carries no number and belongs to the series ("Mad
  // Max (2)" is The Road Warrior; not for the first); else the Nth by year of the titles starting with the name,
  // from the one named exactly that, titles numbered otherwise left out ("The Hunger Games (2)" is Catching Fire,
  // not Mockingjay - Part 2). On a TV show a number is a season, and Qloo keeps a show as one entry: the show.
  const numbers = titleWords.filter((w) => NUMBER.has(w));
  const anchor = named_ ? r!.pick : null;
  const show = (anchor ?? found[0])?.types.includes("urn:entity:tv_show");
  // A season note on a show ("Stranger Things (Season 5)", "Squid Game (Season 2)") is the show: no companion or
  // making-of title ("Stranger Things 5: Behind the Episode", "Squid Game: Making Season 2") is taken or offered first.
  const season = show && numbers.length === 1 && titleWords.length === 1;
  if (numbers.length === 1 && titleWords.length === 1 && !show) {
    const n = NUMBER.get(numbers[0])! + 1;
    // The number a title gives itself right after the name ("Rocky III", "The Two Towers"), if any.
    const ownNumber = (e: Entity) => {
      const rest = isArtist(e) ? null : wordsAfter(e.name, named);
      const w = rest?.find((x) => !PART.has(x) && !SMALL.has(x) && !LINKS.has(x));
      return w && NUMBER.has(w) ? w : null;
    };
    // Or a title holding the name and the number, not after a part word ("2 Fast 2 Furious"; not "Mockingjay - Part 2").
    const carries = (e: Entity) => {
      const ws = words(e.name);
      return !isArtist(e) && !startsWithName(e) && holdsName(e) && ws.some((w, i) => sameWord(numbers[0], w) && !(i > 0 && PART.has(ws[i - 1])));
    };
    const numbered = [...found.filter((e) => ownNumber(e) && sameWord(numbers[0], ownNumber(e)!)), ...found.filter(carries)];
    const hasNumber = (e: Entity) => words(e.name).some((w) => NUMBER.has(w));
    const top = found[0];
    const trusted = n > 1 && !!top && !isArtist(top) && top !== anchor && !hasNumber(top) && (anchor ? yearOf(top) > yearOf(anchor) : holdsName(top));
    const since = anchor ? yearOf(anchor) : NaN;
    const later = found
      .filter((e) => e !== anchor && !isArtist(e) && startsWithName(e) && !ownNumber(e) && !Number.isNaN(yearOf(e)) && (Number.isNaN(since) || yearOf(e) > since))
      .map((e, i) => ({ e, i }))
      .sort((x, y) => yearOf(x.e) - yearOf(y.e) || x.i - y.i)
      .map((x) => x.e);
    const series = anchor ? [anchor, ...later] : later;
    const pick = numbered[0] ?? (trusted ? top : series[n - 1]);
    if (pick) {
      const byName = rankTyped(found, bare);
      return { pick, match: "closest", list: [pick, ...(byName?.list ?? []).filter((e) => e !== pick)], offered: (e) => !!byName?.offered(e) && holdsName(e), note: "title", searchName: !numbered.length && !anchor && !trusted };
    }
  }
  const held = season ? [] : found.filter((e) => !isArtist(e) && holdsExactly(e, titleWords) && holdsExactly(e, named));
  const titled = held.filter((e) => !named_ || (!fuller && (subtitle(e) || spinOff(e) || franchise(e))));
  if (titled.length) {
    // The title holding more of the note's words first, part words too ("Star Wars (Episode 1)" is Episode I, not
    // Rogue One), then the closer one.
    const heldNote = (e: Entity) => noteLead.filter((w) => words(e.name).some((x) => sameWord(w, x))).length;
    const near = (e: Entity) => share(words(input), words(e.name)) + share(words(e.name), words(input));
    const pick = titled.map((e, i) => ({ e, i, h: heldNote(e), s: near(e) })).sort((x, y) => y.h - x.h || y.s - x.s || x.i - y.i)[0].e;
    const byName = rankTyped(found, bare);
    // A title that doesn't start with the name, with no entry named exactly that among the answers: the name alone is
    // searched too, since Qloo's search for the whole text can miss it ("The Mandalorian (Star Wars)" found Lego Star
    // Wars: The Mandalorian but not The Mandalorian).
    return { pick, match: "closest", list: [pick, ...(byName?.list ?? []).filter((e) => e !== pick)], offered: (e) => !!byName?.offered(e) && holdsName(e), note: "title", searchName: !startsWithName(pick) };
  }
  // The note names one title exactly ("Indiana Jones (Raiders of the Lost Ark)", "La Casa de Papel (Money Heist)"):
  // a name of two words or more, not all kind words, never an act (an act's note is as often a hometown that is
  // also a band's name: "Moonsprout (New England)"). The name alone is searched first, since an entry named exactly
  // that wins and may not be among the whole text's answers ("Fast & Furious (Fast Five)" found Fast Five only).
  // "aka" says the note is another name, so then an act may take it too, and one word is enough ("Ye (aka Kanye West)").
  // The note as typed first ("That '70s Show" ends in a kind word but is a title), then without its kind words.
  const asTitle = (cands: Entity[]) => {
    const whole = rankTyped(cands, rawNote);
    return whole && whole.match !== "closest" ? whole : rankTyped(cands, noted);
  };
  const other = aka ? asTitle(found) : noteWords.length >= 2 && noteWords.some((w) => !KIND.has(w) && !/^\d{4}$/.test(w)) ? asTitle(found.filter((e) => !isArtist(e))) : null;
  const otherPick = other && other.match !== "closest" ? other.pick : null;
  if (otherPick && !named_) return { ...other!, match: "closest", note: "other name", searchName: true };
  if (r) {
    // A year picks among the near names by Qloo's disambiguation: "The Lord of the Rings (2001)" is The Fellowship of
    // the Ring, not the 1978 film named exactly that.
    const year = years(noted);
    const said = year.length ? r.list.filter((e) => holds(e, named) && years(e.disambiguation).some((y) => year.includes(y))) : [];
    if (said.length) return { ...r, pick: said[0], match: "closest", list: [said[0], ...r.list.filter((e) => e !== said[0])], note: "year" };
    // A title named in the note, or one holding the name and the note that wasn't taken, is offered first.
    const offer = [...(otherPick ? [otherPick] : []), ...held].filter((e, i, a) => a.indexOf(e) === i && e !== r.pick);
    return { ...r, match: r.match === "exact" ? "closest" : r.match, list: [r.pick, ...offer, ...r.list.filter((e) => e !== r.pick && !offer.includes(e))], offered: (e) => offer.includes(e) || (r.offered(e) && holdsName(e)), note: "name", searchName: r.match === "closest" || year.length > 0 };
  }
  return null;
}

// Search results for the whole text, then those for the name alone that weren't among them.
export const together = (a: Entity[], b: Entity[]) => [...a, ...b.filter((e) => !a.some((x) => x.id === e.id))];

// The candidates Qloo's search returned for what was typed, ranked; null when none resembles it (no note reading).
function rankTyped(found: Entity[], input: string): Ranked | null {
  // Typed with an article, the name letter for letter comes first ("The Killers" is The Killers before
  // Killers; "A Savage" is A. Savage before Savage), and a name equal without the article still makes it
  // ambiguous ("The Eagles" may mean Eagles). Typed without one, the spelling says nothing about the article:
  // "Killers" is ambiguous between The Killers and Killers, in Qloo's order.
  const literalKey = allWords(input).join(" ");
  const startsWithArticle = allWords(input).length > 1 && ARTICLES.has(allWords(input)[0]); // also "A. Savage"
  // Among those, a typed initial puts the record written the same way first ("A. Savage" is A. Savage before A
  // Savage); typed without the dot, Qloo's order stands.
  const literally = startsWithArticle ? found.filter((e) => allWords(e.name).join(" ") === literalKey) : [];
  if (!article(input, allWords(input))) literally.sort((x, y) => Number(nameKey(y.name) === nameKey(input)) - Number(nameKey(x.name) === nameKey(input)));
  const spaced = [...literally, ...found.filter((e) => nameKey(e.name) === nameKey(input) && !literally.includes(e))];
  const initials = (x: string) => words(x).some((w) => w.length === 1);
  const same = (e: Entity) => squashed(e.name) === squashed(input);
  const exact = spaced.length ? spaced : found.filter((e) => (initials(input) || initials(e.name)) && same(e));
  // Otherwise the same letters spaced differently are the closest match: "ACDC" for AC/DC, "boy genius" for
  // boygenius, ahead of other near names.
  // A near name must resemble from both sides unless what was typed is part of it: "Marcia Ball" shares one
  // word with "Cock and Ball Torture" (half of what was typed, a quarter of that name), while "Edward Sharpe"
  // is part of "Edward Sharpe & The Magnetic Zeros".
  // Otherwise half of what was typed, small words aside, must be close to the name and half the name to what
  // was typed, and near names are ranked by how close they are, not Qloo's order ("Tom Pety" is Tom Petty,
  // not Tom Waits). "Not it?" offers only names closer than that: most of what was typed ("Big Thief" isn't
  // offered Big Sean; "Horse Jumper of Love" isn't offered Love of Lesbian).
  const typedWords = words(input);
  // Typed with its article, the name must hold the article too, in place ("The Hip" in The Hip Abduction) or
  // leading the name ("The Hip" in The Tragically Hip; "The Weekend" isn't in Vampire Weekend, "The The" isn't
  // in The Head and the Heart).
  const literal = (e: Entity) => ` ${allWords(e.name).join(" ")} `.includes(` ${literalKey} `);
  const typedArticle = article(input, allWords(input)) ? allWords(input)[0] : "";
  const leading = (e: Entity) =>
    !!typedArticle && allWords(e.name)[0] === typedArticle && typedWords.some((w) => !SMALL.has(w)) && ` ${words(e.name).join(" ")} `.includes(` ${typedWords.join(" ")} `);
  const inside = (e: Entity) => literal(e) || leading(e);
  const part = (e: Entity) => { const n = words(e.name); return ` ${typedWords.join(" ")} `.includes(` ${n.join(" ")} `) && n.length * 2 >= typedWords.length; };
  const sure = (e: Entity) => exact.includes(e) || same(e) || inside(e) || part(e);
  // Near names rank in three tiers. A name holding everything typed comes first ("Mavis" is Mavis Staples,
  // not The Mavis's; "Margo" is Margo Price, not Margot); then a whole name one letter off ("Future Island"
  // is Future Islands, not Future; "De La Sol" is De La Soul, whose short words must otherwise match
  // exactly; "Boy Genious" is boygenius); then the rest by closeness. Not one letter off: a name held whole by
  // what was typed (Hank Williams for "Hank Williams 3"), or a word of one or two letters swapped (Hank
  // Williams Jr. for "Hank Williams Sr.", Chapter 8 for "Chapter 4").
  const typedWhole = squashed(input);
  const whole = (e: Entity) => {
    const n = squashed(e.name), nw = words(e.name);
    if (Math.min(n.length, typedWhole.length) < 5 || typoDistance(n, typedWhole) > 1 || part(e)) return false;
    return nw.length !== typedWords.length || nw.every((w, i) => w === typedWords[i] || Math.min(w.length, typedWords[i].length) >= 3);
  };
  const closeness = (e: Entity) => share(typedWords, words(e.name)) + share(words(e.name), typedWords);
  // A name held only after a leading article ranks below one letter off that also leads with it: "The Monkeys"
  // is The Monkees, not The Mighty Monkeys; but "The Stones" is The Rolling Stones, not Stone or The Stone (a
  // plural of it isn't a typo; "The Killer" is still The Killers, not The Lady Killer).
  const pluralOf = (e: Entity) => { const n = squashed(e.name); return [`${n}s`, `${n}es`].includes(typedWhole); };
  const anyWhole = found.some((e) => whole(e) && allWords(e.name)[0] === typedArticle && !pluralOf(e));
  const score = (e: Entity) => (exact.includes(e) || same(e) ? 100 : (literal(e) ? 30 : whole(e) ? 20 : leading(e) ? (anyWhole ? 10 : 30) : 0) + closeness(e));
  const near = (e: Entity) => sure(e) || whole(e) || (share(typedWords, words(e.name)) >= 0.5 && share(words(e.name), typedWords) >= 0.5);
  const list = found.filter(near).map((e, i) => ({ e, i, s: score(e) })).sort((x, y) => y.s - x.s || x.i - y.i).map((x) => x.e);
  if (!list.length) return null;
  // Not it? doesn't offer a mere plural of an exact one-word name ("Kiss" isn't offered Kisses), but does for
  // longer names ("Black Key" is offered The Black Keys) and when nothing matched exactly ("The Car": The Cars).
  const plurals = typedWords.filter((w) => !SMALL.has(w)).length > 1 || !exact.length;
  // Nor, next to an exact match, a fragment of what was typed ("Graves" for Shakey Graves, W.E.T. for Wet Leg).
  const fragment = (e: Entity) => !!exact.length && part(e) && !inside(e) && !exact.includes(e) && !same(e);
  const offered = (e: Entity) => (sure(e) && !fragment(e)) || share(typedWords, words(e.name), plurals) > 0.5;
  const pick = exact[0] ?? list[0];
  return { pick, match: exact.length === 1 ? "exact" : exact.length > 1 ? "ambiguous" : "closest", list, offered };
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
  const first = await q.search(input.replace(/,/g, " "), "urn:entity:place", 8);
  let found = first.filter(isRoom);
  let chosen = chooseVenue(input, found);
  // The city in the query can throw Qloo's search off ("Brooklyn Steel New York" returns hotels and a
  // steakhouse, not Brooklyn Steel): when nothing matched by name, ask again with the name alone (before the
  // comma, or without the place words that end the text, as any result places them, room or not).
  let name = input.split(",")[0].trim();
  if (name === input.trim()) {
    const places = new Set(first.flatMap((e) => [...locationOf(e).all]));
    const ws = name.split(/\s+/);
    while (ws.length > 1 && places.has(words(ws[ws.length - 1]).join(" "))) ws.pop();
    name = ws.join(" ");
  }
  if (name !== input.trim() && (!chosen || !chosen.exact.length)) {
    const seen = new Set(found.map((e) => e.id));
    const more = (await q.search(name, "urn:entity:place", 8)).filter((e) => isRoom(e) && !seen.has(e.id));
    if (more.length) {
      found = [...found, ...more];
      chosen = chooseVenue(input, found);
    }
  }
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
