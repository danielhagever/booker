// Everything that comes from a visitor or an agent is checked here before it reaches Qloo.

import type { Named } from "./booker.ts";

export const MAX_ACTS = 8;
export const MAX_PITCHES = 8;
export const MAX_CITIES = 5;
export const MAX_NAME = 80;

const TAG_OR_ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validId = (id: string) => TAG_OR_ENTITY_ID.test(id);

export const clean = (v: unknown, max = MAX_NAME): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// A list of names: an array of strings or {name, id} objects, or one text separated by commas,
// semicolons or new lines. A name with a comma goes in quotes: "Tyler, the Creator". Splitting never
// happens on "and": "Simon and Garfunkel" stays one name.
export function splitNames(text: string): string[] {
  return parseNames(singleQuoted(text)) ?? text.split(/[,;\n]/).map((x) => x.replace(/["“”„«»]/g, ""));
}

// Single quotes quote a name only when they open it, close it just before a separator, and hold a comma
// and no apostrophe: 'Black Country, New Road' and ‘Tyler, the Creator’ stay whole, while 'Til Tuesday,
// Keb' Mo' and ‘68 are names with apostrophes.
function singleQuoted(text: string): string {
  return text.replace(/(^|[,;\n]\s*)['‘]([^'‘’\n]*,[^'‘’\n]*)['’](?=\s*(?:[,;\n]|$))/g, "$1“$2”");
}

// Double quotes keep a name whole: "...", “...”, „...“ or „...”, «...». Apostrophes never quote
// ('Til Tuesday, Keb' Mo', ‘68). A quote left open returns null, and the text is split plainly, so one
// stray quote can't join the list.
function parseNames(text: string): string[] | null {
  const CLOSE: Record<string, string> = { '"': '"', "“": "”", "„": "“”", "«": "»" };
  const out: string[] = [];
  let cur = "";
  let closer = "";
  for (const ch of text) {
    if (closer && closer.includes(ch)) closer = "";
    else if (!closer && CLOSE[ch]) closer = CLOSE[ch];
    else if (!closer && (ch === "," || ch === ";" || ch === "\n")) (out.push(cur), (cur = ""));
    else cur += ch;
  }
  out.push(cur);
  return closer ? null : out;
}

export function names(v: unknown, max: number): { list: Named[]; leftOut: string[] } {
  const raw: unknown[] = typeof v === "string" ? splitNames(v) : Array.isArray(v) ? v : [];
  const all: Named[] = [];
  for (const r of raw) {
    const name = clean(typeof r === "string" ? r : (r as any)?.name);
    if (name.length < 1) continue;
    const id = clean((r as any)?.id, 40);
    if (all.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    all.push({ name, ...(id && validId(id) ? { id } : {}) });
  }
  return { list: all.slice(0, max), leftOut: all.slice(max).map((n) => n.name) };
}

// Cities: one per line or separated by semicolons. A line with one comma is one city ("Austin, Texas",
// "Melbourne, Victoria"), and so is "City, State, Country". A line of city names with commas and no state
// or country among them ("Chicago, Austin, Asheville") is split. Anything else ("Boston, New York,
// Philadelphia, Washington": New York and Washington are states too) isn't guessed at: it is reported as
// not used, with a note to put one city per line.
const STATES: [string, string, string?][] = [
  ["alabama", "al", "ala"], ["alaska", "ak"], ["arizona", "az", "ariz"], ["arkansas", "ar", "ark"], ["california", "ca", "calif"],
  ["colorado", "co", "colo"], ["connecticut", "ct", "conn"], ["delaware", "de", "del"], ["district of columbia", "dc"], ["florida", "fl", "fla"],
  ["georgia", "ga"], ["hawaii", "hi"], ["idaho", "id"], ["illinois", "il", "ill"], ["indiana", "in", "ind"], ["iowa", "ia"], ["kansas", "ks", "kan"],
  ["kentucky", "ky"], ["louisiana", "la"], ["maine", "me"], ["maryland", "md"], ["massachusetts", "ma", "mass"], ["michigan", "mi", "mich"],
  ["minnesota", "mn", "minn"], ["mississippi", "ms", "miss"], ["missouri", "mo"], ["montana", "mt", "mont"], ["nebraska", "ne", "neb"],
  ["nevada", "nv", "nev"], ["new hampshire", "nh"], ["new jersey", "nj"], ["new mexico", "nm"], ["new york", "ny"], ["north carolina", "nc"],
  ["north dakota", "nd"], ["ohio", "oh"], ["oklahoma", "ok", "okla"], ["oregon", "or", "ore"], ["pennsylvania", "pa", "penn"],
  ["rhode island", "ri"], ["south carolina", "sc"], ["south dakota", "sd"], ["tennessee", "tn", "tenn"], ["texas", "tx", "tex"], ["utah", "ut"],
  ["vermont", "vt"], ["virginia", "va"], ["washington", "wa", "wash"], ["west virginia", "wv", "wva"], ["wisconsin", "wi", "wis"],
  ["wyoming", "wy", "wyo"], ["ontario", "on", "ont"], ["quebec", "qc"], ["british columbia", "bc"], ["alberta", "ab", "alta"],
  ["manitoba", "mb"], ["saskatchewan", "sk"], ["nova scotia", "ns"], ["new brunswick", "nb"], ["newfoundland and labrador", "nl"],
  ["prince edward island", "pe"],
];
const COUNTRIES = (
  "usa,us,united states,united states of america,uk,united kingdom,great britain,england,scotland,wales,northern ireland,ireland,canada,mexico," +
  "germany,france,spain,italy,portugal,netherlands,the netherlands,belgium,luxembourg,switzerland,austria,denmark,sweden,norway,finland,iceland," +
  "poland,czech republic,czechia,hungary,greece,turkey,israel,australia,new zealand,japan,south korea,korea,china,taiwan,india,brazil,argentina," +
  "chile,colombia,peru,south africa"
).split(",");
const REGIONS = new Set([...STATES.flat().filter((x): x is string => !!x), ...COUNTRIES]);
const isRegion = (p: string) => REGIONS.has(p.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " "));
const UNCLEAR = " (one city per line, please)";
function splitCities(line: string): string[] {
  const parts = line.split(",");
  if (parts.length <= 2) return [line];
  if (parts.length === 3 && isRegion(parts[1]) && isRegion(parts[2])) return [line];
  if (!parts.slice(1).some(isRegion)) return parts;
  return [line + UNCLEAR];
}

export function cityList(v: unknown): { list: string[]; leftOut: string[] } {
  const raw: unknown[] = typeof v === "string" ? v.split(/[;\n|]+/).flatMap(splitCities) : Array.isArray(v) ? v : [];
  const all = [...new Set(raw.map((c) => clean(c, 160)).filter((c) => c.length >= 2))];
  const unclear = all.filter((c) => c.endsWith(UNCLEAR));
  const usable = all.filter((c) => !c.endsWith(UNCLEAR)).map((c) => c.slice(0, MAX_NAME));
  return { list: usable.slice(0, MAX_CITIES), leftOut: [...unclear, ...usable.slice(MAX_CITIES).map((c) => `${c} (more than ${MAX_CITIES})`)] };
}
