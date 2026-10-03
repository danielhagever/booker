// A stand-in for Qloo and Open-Meteo, plus a KV that counts its operations, so the tests can check every
// rule (and the 50-subrequest limit) without a key. Shapes follow the live hackathon API as measured on
// 2026-10-03 (scripts/probe1-6.mjs): /search -> results[] (entity_id, name, types, popularity, tags,
// properties.geocode, location); /entities -> results[]; /v2/insights -> results.entities[] with
// query.affinity, plus query.localities.signal when a location query was given.

export interface Call {
  host: string;
  path: string;
  params: URLSearchParams;
}

export type Handler = (c: Call) => { status?: number; body: unknown } | undefined;

export function mockFetch(handler: Handler) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    const c = { host: u.host, path: u.pathname, params: u.searchParams };
    calls.push(c);
    const r = handler(c) ?? defaults(c);
    if (!r) return new Response("not mocked", { status: 599 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

export const CITIES: Record<string, any> = {
  chicago: { id: 4887398, name: "Chicago", latitude: 41.85, longitude: -87.65, country_code: "US", admin1: "Illinois", country: "United States", population: 2720546 },
  austin: { id: 4671654, name: "Austin", latitude: 30.267, longitude: -97.743, country_code: "US", admin1: "Texas", country: "United States", population: 960000 },
  asheville: { id: 4453066, name: "Asheville", latitude: 35.6, longitude: -82.55, country_code: "US", admin1: "North Carolina", country: "United States", population: 94589 },
};

function defaults(c: Call): { status?: number; body: unknown } | undefined {
  if (c.host === "geocoding-api.open-meteo.com") {
    const name = (c.params.get("name") ?? "").toLowerCase();
    return { body: { results: CITIES[name] ? [CITIES[name]] : [] } };
  }
  return undefined;
}

export const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function artist(n: number, name: string, popularity: number, genres: string[] = ["Indie"], affinity?: number) {
  return {
    entity_id: UUID(n),
    name,
    types: ["urn:entity:artist"],
    popularity,
    tags: genres.map((g) => ({ name: g, type: "urn:tag:genre:music" })),
    ...(affinity !== undefined ? { query: { affinity } } : {}),
  };
}

export function venue(n: number, name: string, city: string, region: string, categories = ["Bar", "Live music venue"], affinity?: number) {
  return {
    entity_id: UUID(n),
    name,
    types: ["urn:entity:place"],
    popularity: 0.99,
    location: { lat: 41.9 + n / 1000, lon: -87.68 },
    properties: { address: `${n} Main St ${city}`, geocode: { city, admin1_region: region, country_code: "US", country: "United States" } },
    tags: categories.map((c) => ({ name: c, type: "urn:tag:category:place" })),
    ...(affinity !== undefined ? { query: { affinity } } : {}),
  };
}

export function memoryKV(opts: { failPuts?: boolean } = {}) {
  const store = new Map<string, string>();
  const ops = { get: 0, put: 0 };
  const kv = {
    async get(key: string, type?: string) {
      ops.get++;
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      ops.put++;
      if (opts.failPuts) throw new Error("KV put() limit exceeded for the day.");
      store.set(key, value);
    },
  };
  return { kv: kv as unknown as KVNamespace, store, ops };
}

// No pacing between Qloo calls in tests (one test checks the real pacing).
export const ENV = (kv: KVNamespace) => ({ QLOO_API_KEY: "test-key", QLOO_BASE_URL: "https://qloo.test", QLOO_MIN_GAP_MS: "0", CACHE: kv });
