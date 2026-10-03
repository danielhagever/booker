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
const COUNTRY_WORDS: Record<string, string> = { usa: "us", "united states": "us", us: "us", uk: "gb", "united kingdom": "gb", england: "gb" };

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
export async function cityCenter(cache: KVNamespace, budget: Budget, city: string): Promise<Place | null> {
  const key = `city4:${city.toLowerCase()}`;
  const hit = await kvGet(cache, budget, key);
  if (hit) return hit as Place;
  const [name, ...rest] = city.split(",").map((x) => x.trim());
  if (!name) return null;
  const raw = rest.join(" ").toLowerCase().replace(/\./g, "").trim();
  const qualifier = US_STATES[raw]?.toLowerCase() ?? raw;
  const country = COUNTRY_WORDS[raw];
  let list = await geocode(budget, name, "en");
  // A city typed in Hebrew, Arabic or Cyrillic is only found in its own language; its English name
  // (what Qloo is asked about) then comes from the same place's record.
  const script = /[\u0590-\u05FF]/.test(name) ? "he" : /[\u0600-\u06FF]/.test(name) ? "ar" : /[\u0400-\u04FF]/.test(name) ? "ru" : "";
  if (!list.length && script) {
    const native = (await geocode(budget, name, script)).sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
    if (native?.id) list = await byId(budget, native.id);
  }
  if (!list.length) return null;
  const matches = country
    ? list.filter((r) => String(r.country_code ?? "").toLowerCase() === country)
    : qualifier
      ? list.filter((r) =>
          [r.admin1, r.country].some((v) => v && (String(v).toLowerCase() === qualifier || (qualifier.length > 3 && String(v).toLowerCase().includes(qualifier)))),
        )
      : [];
  const pool = matches.length ? matches : list;
  const r = [...pool].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
  // US and Canadian cities are named with their state or province; elsewhere with the country. The
  // region is kept even when it repeats the name: Qloo reads "New York" as the state and
  // "New York, New York" as the city (measured).
  const region = r.country_code === "US" || r.country_code === "CA" ? r.admin1 : r.country;
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
