// Where a city is (Open-Meteo geocoding), so Qloo is asked about the right one ("Portland, Maine", not
// Portland, Oregon). Caching is best effort: the free plan allows 1,000 KV writes a day, and a failed
// write must never fail a search.

import { AppError, Budget, fetchWithTimeout } from "./limits.ts";

const UA = { "user-agent": "Booker/0.1 (Qloo hackathon demo; github.com/danielhagever/booker)" };

export interface Place {
  lat: number;
  lon: number;
  name: string; // what the page shows, e.g. "Portland, Maine"
  query: string; // what Qloo is asked for: the same city, spelled out
  // Set when what came after the comma isn't this city's state or country ("Chicago, Austin"): the city
  // was then taken as the most populous of its name, and the answer says how it was read.
  unmatched?: string;
}

const US_STATES: Record<string, string> = {
  al: "Alabama", ak: "Alaska", az: "Arizona", ar: "Arkansas", ca: "California", co: "Colorado", ct: "Connecticut",
  de: "Delaware", dc: "District of Columbia", fl: "Florida", ga: "Georgia", hi: "Hawaii", id: "Idaho", il: "Illinois",
  in: "Indiana", ia: "Iowa", ks: "Kansas", ky: "Kentucky", la: "Louisiana", me: "Maine", md: "Maryland",
  ma: "Massachusetts", mi: "Michigan", mn: "Minnesota", ms: "Mississippi", mo: "Missouri", mt: "Montana",
  ne: "Nebraska", nv: "Nevada", nh: "New Hampshire", nj: "New Jersey", nm: "New Mexico", ny: "New York",
  nc: "North Carolina", nd: "North Dakota", oh: "Ohio", ok: "Oklahoma", or: "Oregon", pa: "Pennsylvania",
  ri: "Rhode Island", sc: "South Carolina", sd: "South Dakota", tn: "Tennessee", tx: "Texas", ut: "Utah",
  vt: "Vermont", va: "Virginia", wa: "Washington", wv: "West Virginia", wi: "Wisconsin", wy: "Wyoming",
};
// Province and state codes outside the US ("Toronto, ON", "Melbourne, VIC"); a code can name more than one
// region (NT: Northwest Territories or Northern Territory), and the city's own record decides which.
const OTHER_REGIONS: Record<string, string[]> = {
  on: ["Ontario"], qc: ["Quebec"], bc: ["British Columbia"], ab: ["Alberta"], mb: ["Manitoba"], sk: ["Saskatchewan"],
  ns: ["Nova Scotia"], nb: ["New Brunswick"], nl: ["Newfoundland and Labrador"], pe: ["Prince Edward Island"], yt: ["Yukon"],
  nu: ["Nunavut"], nt: ["Northwest Territories", "Northern Territory"], nsw: ["New South Wales"], vic: ["Victoria"],
  qld: ["Queensland"], wa: ["Western Australia"], sa: ["South Australia"], tas: ["Tasmania"], act: ["Australian Capital Territory"],
};
const COUNTRY_WORDS: Record<string, string> = { usa: "us", "united states": "us", us: "us", uk: "gb", "united kingdom": "gb", england: "gb", scotland: "gb", wales: "gb" };

async function kvGet(cache: KVNamespace, budget: Budget, key: string): Promise<any> {
  if (!budget.take()) return null;
  try {
    return await cache.get(key, "json");
  } catch {
    return null;
  }
}

async function kvPut(cache: KVNamespace, budget: Budget, key: string, value: unknown, ttl: number): Promise<void> {
  if (!budget.take()) return;
  try {
    await cache.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch {
    // Daily write limit or a hiccup: the search still succeeds, it just isn't cached.
  }
}

// "Portland, Maine", "Portland, ME" and "Portland, Oregon" must each land on the right Portland:
// fetch several candidates and prefer the one whose state or country matches what came after the
// comma; otherwise take the most populous.
// Typed forms that Open-Meteo doesn't know by that name.
const ALIASES: Record<string, string> = {
  dc: "Washington, DC", "washington dc": "Washington, DC", cdmx: "Mexico City", "ciudad de mexico": "Mexico City",
  "quebec city": "Quebec, QC", "tel aviv-yafo": "Tel Aviv", "tel aviv yafo": "Tel Aviv",
};
// Newspaper (AP) state abbreviations, dots dropped ("Paris, Tex.", "Springfield, Ill.").
const US_AP: Record<string, string> = {
  ala: "Alabama", ariz: "Arizona", ark: "Arkansas", calif: "California", colo: "Colorado", conn: "Connecticut", del: "Delaware",
  fla: "Florida", ill: "Illinois", ind: "Indiana", kan: "Kansas", kans: "Kansas", mass: "Massachusetts", mich: "Michigan",
  minn: "Minnesota", miss: "Mississippi", mont: "Montana", neb: "Nebraska", nebr: "Nebraska", nev: "Nevada", okla: "Oklahoma",
  ore: "Oregon", oreg: "Oregon", penn: "Pennsylvania", tenn: "Tennessee", tex: "Texas", wash: "Washington", wis: "Wisconsin",
  wyo: "Wyoming", wva: "West Virginia",
};
// Countries as people write them in their own language.
const ENDONYMS: Record<string, string> = {
  brasil: "Brazil", deutschland: "Germany", espana: "Spain", italia: "Italy", osterreich: "Austria", schweiz: "Switzerland",
  suisse: "Switzerland", nederland: "Netherlands", sverige: "Sweden", norge: "Norway", danmark: "Denmark", polska: "Poland",
  eire: "Ireland", mexico: "Mexico", "great britain": "United Kingdom", britain: "United Kingdom",
};
const fold = (s: unknown) => String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
// What a region word can mean: "tx" Texas, "on" Ontario, "wa" Washington or Western Australia.
const regionNames = (part: string) =>
  [part, US_STATES[part], US_AP[part], ...(OTHER_REGIONS[part] ?? []), ENDONYMS[part]].filter(Boolean).map((x) => fold(x));
const KNOWN_REGIONS = new Set([
  ...Object.keys(US_STATES), ...Object.values(US_STATES).map(fold), ...Object.keys(US_AP), ...Object.keys(OTHER_REGIONS),
  ...Object.values(OTHER_REGIONS).flat().map(fold), ...Object.keys(COUNTRY_WORDS), ...Object.keys(ENDONYMS),
  "canada", "australia", "germany", "france", "spain", "italy", "ireland", "netherlands", "japan", "mexico", "brazil", "israel",
]);
// "St. Paul", "Saint Paul" and "St Paul" are one place to a person, but Open-Meteo knows one spelling.
function spellings(name: string): string[] {
  const m = name.match(/^(st|saint|ste|sainte|ft|fort|mt|mount)\.?\s+(.+)$/i);
  if (!m) return [name];
  const head = m[1].toLowerCase();
  const forms = ["st", "saint"].includes(head) ? ["St.", "Saint"] : ["ste", "sainte"].includes(head) ? ["Ste.", "Sainte"] : ["ft", "fort"].includes(head) ? ["Fort", "Ft."] : ["Mount", "Mt."];
  return [name, ...forms.map((f) => `${f} ${m[2]}`).filter((x) => fold(x) !== fold(name))];
}

export async function cityCenter(cache: KVNamespace, budget: Budget, city: string): Promise<Place | null> {
  const key = `city6:${city.toLowerCase()}`;
  const hit = await kvGet(cache, budget, key);
  if (hit) return hit as Place;
  const typed = ALIASES[fold(city)] ?? city;
  let [name, ...rest] = typed.split(",").map((x) => x.trim());
  if (!name) return null;
  // Without a comma the state or country may close the text: "Austin TX", "Portland Maine", "London England".
  if (!rest.filter(Boolean).length) {
    const ws = name.split(/\s+/);
    for (const k of [2, 1]) {
      if (ws.length > k && KNOWN_REGIONS.has(fold(ws.slice(-k).join(" ")))) {
        rest = [ws.slice(-k).join(" ")];
        name = ws.slice(0, -k).join(" ");
        break;
      }
    }
  }
  // Each part after the name must fit the city: "Austin, TX, USA" is Texas and the United States.
  const parts = rest.map(fold).filter(Boolean);
  const seen = new Set<unknown>();
  let list: any[] = [];
  const idOf = (r: any) => r.id ?? [r.name, r.admin1, r.country_code, r.latitude, r.longitude].join("|");
  for (const n of spellings(name)) for (const r of await geocode(budget, n, "en")) if (!seen.has(idOf(r))) (seen.add(idOf(r)), list.push(r));
  // A city typed in Hebrew, Arabic or Cyrillic is only found in its own language; its English name
  // (what Qloo is asked about) then comes from the same place's record.
  const script = /[\u0590-\u05FF]/.test(name) ? "he" : /[\u0600-\u06FF]/.test(name) ? "ar" : /[\u0400-\u04FF]/.test(name) ? "ru" : "";
  if (!list.length && script) {
    const native = (await geocode(budget, name, script)).sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
    if (native?.id) list = await byId(budget, native.id);
  }
  if (!list.length) return null;
  const fits = (r: any, part: string) => {
    const own = [r.admin1, r.country].filter(Boolean).map(fold);
    const cc = fold(r.country_code);
    return regionNames(part).some((n) => own.some((v) => v === n || (n.length > 3 && v.includes(n)))) || COUNTRY_WORDS[part] === cc || (part.length === 2 && part === cc);
  };
  const matches = parts.length ? list.filter((r) => parts.every((p) => fits(r, p))) : [];
  const pool = matches.length ? matches : list;
  // Towns and cities first (Open-Meteo lists Vancouver Island above the city of Vancouver), unless an island
  // or region is far bigger than any town of that name (Long Island, Maui).
  const pop = (r: any) => r.population ?? 0;
  const byPop = (xs: any[]) => [...xs].sort((a, b) => pop(b) - pop(a))[0];
  const town = byPop(pool.filter((r) => /^PPL/.test(String(r.feature_code ?? "PPL"))));
  const other = byPop(pool.filter((r) => !/^PPL/.test(String(r.feature_code ?? "PPL"))));
  const r = town && !(other && pop(other) > 10 * pop(town)) ? town : (other ?? town);
  // US and Canadian cities are named with their state or province; elsewhere with the country. The
  // region is kept even when it repeats the name: Qloo reads "New York" as the state and
  // "New York, New York" as the city (measured).
  // A few records carry no country name (Puerto Rico, Hong Kong): the code names it.
  const NO_COUNTRY: Record<string, string> = { PR: "Puerto Rico", HK: "Hong Kong", MO: "Macau" };
  const region = r.country_code === "US" || r.country_code === "CA" ? r.admin1 : (r.country ?? NO_COUNTRY[r.country_code] ?? r.admin1);
  const label = `${r.name}${region ? ", " + region : ""}`;
  const typedRegion = rest.filter(Boolean).join(", ");
  const out: Place = { lat: r.latitude, lon: r.longitude, name: label, query: label, ...(typedRegion && !matches.length ? { unmatched: typedRegion } : {}) };
  await kvPut(cache, budget, key, out, 60 * 60 * 24 * 30);
  return out;
}

async function geocode(budget: Budget, name: string, language: string): Promise<any[]> {
  if (!budget.take()) throw new AppError("This search needs more lookups than one request allows.", 503);
  try {
    const res = await fetchWithTimeout(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=${language}`,
      { headers: UA },
      6000,
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    return ((await res.json()) as any)?.results ?? [];
  } catch {
    throw new AppError("The city lookup service didn't answer. Please try again.", 502);
  }
}

async function byId(budget: Budget, id: number): Promise<any[]> {
  if (!budget.take()) return [];
  try {
    const res = await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/get?id=${id}&language=en`, { headers: UA }, 6000);
    const r: any = res.ok ? await res.json() : null;
    return r?.name ? [r] : [];
  } catch {
    return [];
  }
}

export function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
