// Qloo hackathon API client for Booker. Parameter names follow Qloo's docs (Entity Type Parameter
// Guide) and were checked against the live hackathon API on 2026-10-03 (scripts/probe1-6.mjs).
// The key stays on the server (a Worker secret) and is never sent to a browser.

import { AppError, Budget, fetchWithTimeout } from "./limits.ts";

export interface QlooEnv {
  QLOO_API_KEY?: string;
  QLOO_BASE_URL?: string;
  QLOO_MIN_GAP_MS?: string; // tests set "0"
}

export interface Entity {
  id: string;
  name: string;
  types: string[];
  disambiguation?: string;
  popularity?: number; // Qloo's popularity percentile (0 to 1)
  affinity?: number; // Qloo's affinity to the request's signals (0 to 1)
  lat?: number;
  lon?: number;
  address?: string;
  city?: string;
  region?: string; // state or province
  country?: string;
  countryCode?: string;
  categories?: string[]; // a place's categories (Live music venue, Bar...)
  genres?: string[]; // an artist's music genres
}

export interface Provenance {
  path: string;
  params: Record<string, string>;
  status: number;
  ms: number;
  count: number;
}

export class QlooError extends AppError {
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message, status);
    this.code = code;
  }
}

// Measured on the hackathon key: heavy insights calls take up to 5 s under load.
const TIMEOUT_MS = 12000;

// Qloo answers 429 to the sixth call within about a second (measured on the hackathon key 2026-10-03: 5
// at once pass, 6 lose one; a steady 4 a second loses one, 3 a second none). Calls start at most every 340 ms.
const MIN_GAP_MS = 340;

// The rooms Booker looks for: places Qloo files as live music venues or concert halls (measured tag IDs).
export const VENUE_TAGS = ["urn:tag:category:place:live_music_venue", "urn:tag:category:place:concert_hall"];

// Same comparison as the official harness's resolver (NFKC, trimmed, lower case).
export const normalizeName = (s: string) => s.normalize("NFKC").trim().toLocaleLowerCase("en-US");

export class Qloo {
  calls: Provenance[] = [];
  env: QlooEnv;
  budget: Budget;
  private gap: number;
  private nextStart = 0;
  constructor(env: QlooEnv, budget: Budget) {
    this.env = env;
    this.budget = budget;
    const g = Number(env.QLOO_MIN_GAP_MS);
    this.gap = env.QLOO_MIN_GAP_MS !== undefined && Number.isFinite(g) && g >= 0 ? g : MIN_GAP_MS;
  }

  // Each call books the next start time when it is made, so calls made together go out in turn.
  private async turn(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextStart);
    this.nextStart = at + this.gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  // One bounded retry: a call from another search at the same moment can still meet a 429.
  private async get(path: string, params: Record<string, string>, retry = true): Promise<any> {
    if (!this.env.QLOO_API_KEY) throw new QlooError("The Qloo API key has not been configured yet.", 503);
    if (!this.budget.take()) throw new QlooError("This search needs more Qloo calls than one request allows. Try fewer names.", 503);
    const base = this.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com";
    await this.turn();
    const t = Date.now(); // the time Qloo took, not the wait for a turn
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${base}${path}?${new URLSearchParams(params)}`,
        { headers: { "X-Api-Key": this.env.QLOO_API_KEY, accept: "application/json" } },
        TIMEOUT_MS,
      );
    } catch (e) {
      this.calls.push({ path, params, status: 0, ms: Date.now() - t, count: 0 });
      if ((e as Error)?.name === "TimeoutError") throw new QlooError("Qloo took too long to answer. Please try again.", 504);
      throw new QlooError("Couldn't reach Qloo. Please try again.", 502);
    }
    const body: any = await res.json().catch(() => ({}));
    const count = Array.isArray(body?.results) ? body.results.length : (body?.results?.entities?.length ?? 0);
    this.calls.push({ path, params, status: res.status, ms: Date.now() - t, count });
    if (res.status === 429 && retry && this.budget.left() > 1) {
      await new Promise((r) => setTimeout(r, 800));
      return this.get(path, params, false);
    }
    if (res.status === 429) throw new QlooError("Qloo's rate limit was reached. Please try again in a minute.", 429);
    if (res.status === 401 || res.status === 403) throw new QlooError("Qloo refused this app's API key, so no search can run right now.", 503);
    if (!res.ok) {
      const detail = String(body?.errors?.[0]?.message ?? body?.error?.message ?? body?.message ?? "");
      // Measured: an unknown city in signal/filter.location.query is a 400 with this message.
      const code = /unable to resolve to a valid locality|no localities/i.test(detail) ? "locality" : undefined;
      throw new QlooError(`Qloo answered ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`, res.status >= 500 ? 502 : res.status, code);
    }
    return body;
  }

  async search(query: string, type: string, take = 5): Promise<Entity[]> {
    const body = await this.get("/search", { query, types: type, take: String(take) });
    const list: any[] = Array.isArray(body?.results) ? body.results : (body?.results?.entities ?? []);
    return list.map(toEntity).filter((e) => e.id && e.name);
  }

  // Full records for IDs a person picked (measured: GET /entities?entity_ids=...).
  async byIds(ids: string[]): Promise<Entity[]> {
    const body = await this.get("/entities", { entity_ids: ids.join(",") });
    const list: any[] = Array.isArray(body?.results) ? body.results : (body?.results?.entities ?? []);
    return list.map(toEntity).filter((e) => e.id && e.name);
  }

  // Artists ranked by Qloo for these signals. `city` is a locality name ("Chicago, Illinois"): measured
  // to work at city level and to come back empty for neighborhoods. `only` scores a given list.
  async artists(o: {
    entities: string[];
    city?: string;
    popMin?: number;
    popMax?: number;
    exclude?: string[];
    only?: string[];
    rising?: boolean;
    take: number;
  }): Promise<{ list: Entity[]; locality?: { name: string; lat: number; lon: number } }> {
    const params: Record<string, string> = { "filter.type": "urn:entity:artist", take: String(Math.min(50, o.take)) };
    if (o.entities.length) params["signal.interests.entities"] = o.entities.join(",");
    if (o.city) params["signal.location.query"] = o.city;
    if (o.popMin !== undefined) params["filter.popularity.min"] = o.popMin.toFixed(4);
    if (o.popMax !== undefined) params["filter.popularity.max"] = o.popMax.toFixed(4);
    if (o.exclude?.length) params["filter.exclude.entities"] = o.exclude.join(",");
    if (o.only?.length) params["filter.results.entities"] = o.only.join(",");
    if (o.rising) params["bias.trends"] = "high";
    const body = await this.get("/v2/insights", params);
    return { list: (body?.results?.entities ?? []).map(toEntity).filter((e: Entity) => e.id && e.name), locality: localityOf(body) };
  }

  // Live music venues and concert halls in a city, ranked by Qloo for these signals.
  async venues(entities: string[], city: string, take: number): Promise<Entity[]> {
    const body = await this.get("/v2/insights", {
      "filter.type": "urn:entity:place",
      "filter.tags": VENUE_TAGS.join(","),
      "operator.filter.tags": "union",
      "filter.location.query": city,
      "signal.interests.entities": entities.join(","),
      take: String(Math.min(50, take)),
    });
    return (body?.results?.entities ?? []).map(toEntity).filter((e: Entity) => e.id && e.name);
  }
}

function localityOf(body: any): { name: string; lat: number; lon: number } | undefined {
  const l = body?.query?.localities?.signal ?? body?.query?.localities?.filter?.[0];
  const lat = num(l?.location?.lat), lon = num(l?.location?.lon);
  return l && Number.isFinite(lat) && Number.isFinite(lon) ? { name: String(l.name ?? ""), lat, lon } : undefined;
}

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" ? n : NaN;
}

const CATEGORY = "urn:tag:category:place";
const GENRE = "urn:tag:genre:music";

function toEntity(e: any): Entity {
  const loc = e.location ?? {};
  const geo = e.properties?.geocode ?? {};
  const tags: { name: string; type: string }[] = (Array.isArray(e.tags) ? e.tags : []).map((t: any) => ({ name: String(t?.name ?? "").trim(), type: String(t?.type ?? "") }));
  const lat = num(loc.lat ?? loc.latitude);
  const lon = num(loc.lon ?? loc.longitude);
  const popularity = num(e.popularity);
  const affinity = num(e.query?.affinity);
  const types: string[] = Array.isArray(e.types) ? e.types : e.subtype ? [e.subtype] : e.type ? [e.type] : [];
  return {
    id: String(e.entity_id ?? e.id ?? ""),
    name: String(e.name ?? "").trim(),
    types,
    disambiguation: typeof e.disambiguation === "string" ? e.disambiguation : undefined,
    popularity: Number.isFinite(popularity) ? popularity : undefined,
    affinity: Number.isFinite(affinity) ? affinity : undefined,
    lat: Number.isFinite(lat) ? lat : undefined,
    lon: Number.isFinite(lon) ? lon : undefined,
    address: typeof e.properties?.address === "string" ? e.properties.address : undefined,
    city: typeof geo.city === "string" ? geo.city : undefined,
    region: typeof geo.admin1_region === "string" ? geo.admin1_region : undefined,
    country: typeof geo.country === "string" ? geo.country : undefined,
    countryCode: typeof geo.country_code === "string" ? geo.country_code : undefined,
    categories: [...new Set(tags.filter((t) => t.type === CATEGORY).map((t) => t.name))].slice(0, 4),
    genres: [...new Set(tags.filter((t) => t.type === GENRE).map((t) => t.name))].slice(0, 3),
  };
}
