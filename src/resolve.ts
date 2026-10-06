// Names typed by a person become Qloo entities the way Qloo's official harness resolves them: an exact
// name is preferred. Qloo's search returns something for almost any text, so a candidate that isn't
// the exact name is used only if it resembles what was typed; the answer says so and offers the others.

import { Qloo, type Entity } from "./qloo.ts";
import { km } from "./geo.ts";
import { SMALL, after, forSearch, nameKey, rankNames, resembles, together, typoDistance, withoutNote, words, wordsResemble } from "./names.ts";
// The shared name rules live in names.ts; the files that took them from here still can.
export { abbreviates, abbreviations, after, credits, forSearch, nameKey, rankNames, resembles, squashed, together, withoutNote } from "./names.ts";

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
