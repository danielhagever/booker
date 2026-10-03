import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { forArtist, forVenue, type Named, type TourResult, type VenueResult } from "./booker.ts";
import { AppError, Budget, REQUEST_BUDGET, allow } from "./limits.ts";
import { MAX_ACTS, MAX_CITIES, MAX_NAME, MAX_PITCHES, clean, cityList, names, validId } from "./input.ts";

export interface Env {
  QLOO_API_KEY?: string;
  QLOO_BASE_URL?: string;
  QLOO_MIN_GAP_MS?: string;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
}

// Per address, per hour, to protect the shared event quota.
const LIMITS = { venue: 20, artist: 20, mcp: 20 };

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const failure = (e: unknown) => {
  if (e instanceof AppError) return { message: e.message, status: e.status >= 400 && e.status <= 599 ? e.status : 500 };
  console.error("booker", String((e as Error)?.stack ?? e));
  return { message: "Something went wrong on our side. Please try again.", status: 500 };
};

// Bump whenever the pipeline or the result format changes, so no one gets yesterday's logic.
const CACHE_VERSION = 3;

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Identical requests are answered from a day's cache (the page says so: the timings in "How we know"
// are from the run that made it). A result where an optional step failed isn't kept.
async function cached<T extends { degraded: boolean }>(env: Env, budget: Budget, kind: string, input: unknown, run: () => Promise<T>): Promise<T & { cached?: boolean }> {
  const key = `${kind}${CACHE_VERSION}:` + (await sha(JSON.stringify(input).toLowerCase()));
  if (budget.take()) {
    try {
      const hit = await env.CACHE.get(key, "json");
      if (hit) return { ...(hit as T), cached: true };
    } catch {
      // A cache miss is fine.
    }
  }
  const r = await run();
  if (!r.degraded && budget.take()) {
    try {
      await env.CACHE.put(key, JSON.stringify(r), { expirationTtl: 60 * 60 * 24 });
    } catch {
      // Daily KV write limit or a hiccup: the result is still returned.
    }
  }
  return r;
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function venueSummary(r: VenueResult): string {
  const where = r.venue.city ? ` (${r.venue.city.split(",")[0]})` : "";
  const fits = r.fits.slice(0, 3).map((f) => f.name);
  const parts = [fits.length ? `For ${r.venue.name}${where}, the acts that fit your crowd and size are ${list(fits)}.` : `For ${r.venue.name}${where}, Qloo found no acts in your size range.`];
  if (r.bills[0]) parts.push(`Try ${r.bills[0].headliner} with ${r.bills[0].opener} opening.`);
  if (r.inbox.length) {
    const n = (v: string) => r.inbox.filter((p) => p.verdict === v).length;
    const said = (
      [
        ["fits", "fits your room", "fit your room"],
        ["smaller", "fits as an opener", "fit as openers"],
        ["bigger", "is bigger than your room", "are bigger than your room"],
        ["off-taste", "is off your crowd's taste", "are off your crowd's taste"],
        ["unscored", "couldn't be scored", "couldn't be scored"],
      ] as const
    )
      .map(([v, one, many]) => [n(v), one, many] as const)
      .filter(([k]) => k)
      .map(([k, one, many]) => `${k} ${k === 1 ? one : many}`);
    parts.push(`From your inbox of ${r.inbox.length}: ${list(said)}.`);
  }
  return parts.join(" ");
}

export function tourSummary(r: TourResult): string {
  const [a, b, c] = r.cities;
  const score = (x: TourResult["cities"][number]) => (x.affinity !== undefined ? ` (${x.affinity.toFixed(3)})` : "");
  const order = [a, b, c].filter(Boolean).map((x) => `${x.label.split(",")[0]}${score(x)}`);
  const rooms = r.cities.filter((x) => x.rooms[0]).slice(0, 3).map((x) => `${x.rooms[0].name} in ${x.label.split(",")[0]}`);
  return `${r.artist.name}'s crowd is strongest in ${order[0]}${order.length > 1 ? `, then ${list(order.slice(1))}` : ""}.${rooms.length ? ` Best-fit rooms: ${list(rooms)}.` : ""}`;
}

// What an agent should tell the person before relying on the answer.
function caveats(r: { acts?: VenueResult["acts"]; venue?: VenueResult["venue"]; artist?: TourResult["artist"]; unresolved?: string[] }): string {
  const picks = [r.venue, ...(r.acts ?? []), r.artist].filter((x): x is NonNullable<typeof x> => !!x);
  const parts = picks
    .filter((p) => p.match === "closest" || p.match === "ambiguous")
    .map((p) => `"${p.input}" was matched to ${p.name} (${p.match === "closest" ? "closest Qloo match, not an exact name" : "several Qloo entries share this name; the first was used"})${p.alternatives.length ? `; alternatives: ${p.alternatives.map((a) => `${a.name}${a.note ? ` (${a.note})` : ""} [id ${a.id}]`).join(", ")}` : ""}.`);
  if (r.unresolved?.length) parts.push(`Not found in Qloo: ${r.unresolved.join(", ")}.`);
  return parts.join(" ");
}

function venueInput(body: any) {
  const venueName = clean(body?.venue?.name ?? body?.venue, 120);
  const venueId = clean(body?.venue?.id ?? body?.venueId, 40);
  const acts = names(body?.acts, MAX_ACTS);
  const pitches = names(body?.pitches, MAX_PITCHES);
  return {
    venue: { name: venueName, ...(venueId && validId(venueId) ? { id: venueId } : {}) } as Named,
    acts: acts.list,
    pitches: pitches.list,
    rising: body?.rising === true,
    leftOut: [...acts.leftOut, ...pitches.leftOut],
  };
}

function artistInput(body: any) {
  const name = clean(body?.artist?.name ?? body?.artist);
  const id = clean(body?.artist?.id ?? body?.artistId, 40);
  const cities = cityList(body?.cities);
  return { artist: { name, ...(id && validId(id) ? { id } : {}) } as Named, cities: cities.list, leftOut: cities.leftOut };
}

function buildServer(env: Env, req: Request): McpServer {
  const server = new McpServer({ name: "booker", version: "0.1.0", title: "Booker: taste-matched booking for independent venues" });
  const named = z.union([z.string().min(1).max(MAX_NAME), z.object({ name: z.string().min(1).max(MAX_NAME), id: z.string().max(40).optional() })]);
  const limited = async <T>(fn: (budget: Budget) => Promise<T>) => {
    const budget = new Budget(REQUEST_BUDGET);
    if (!(await allow(req, "mcp", LIMITS.mcp, budget))) throw new AppError("Too many searches from this address in the last hour. Please try again later.", 429);
    return fn(budget);
  };
  server.registerTool(
    "find_acts_for_venue",
    {
      title: "Find acts that fit a venue's crowd and size",
      description:
        "For a talent buyer at a live music venue: given the venue (name and city) and acts that did well there, ranks artists whose fans overlap with those acts, sized to the room by the acts' Qloo popularity, with the city as a signal; suggests headliner + opener bills; and, if given pitches from the inbox, says which fit, which are bigger or smaller than the room, and which are off the crowd's taste. Use artists' names as Qloo knows them. If a name was only a closest match, the result lists alternatives with Qloo IDs: ask the person which one they meant, then call again with that id.",
      inputSchema: z.object({
        venue: named.describe("The venue with its city, e.g. 'The Empty Bottle, Chicago', or {name, id} from an earlier result's alternatives"),
        acts: z.array(named).min(1).max(MAX_ACTS).describe("Artists that played the venue and sold well"),
        pitches: z.array(named).max(MAX_PITCHES).optional().describe("Artists that pitched the venue, to score"),
        rising: z.boolean().optional().describe("Favor rising acts (Qloo trends)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return await limited(async (budget) => {
          const input = venueInput(args);
          if (input.venue.name.length < 2) throw new AppError("Name the venue and its city.", 400);
          const r = await cached(env, budget, "venue", { v: input.venue, a: input.acts, p: input.pitches, r: input.rising }, () => forVenue(env, budget, input));
          const s = venueSummary(r);
          const notes = caveats(r);
          return { content: [{ type: "text" as const, text: notes ? `${s}\n\n${notes}` : s }], structuredContent: { spoken: s, ...r } };
        });
      } catch (e) {
        return { content: [{ type: "text" as const, text: failure(e).message }], isError: true };
      }
    },
  );
  server.registerTool(
    "find_rooms_for_artist",
    {
      title: "Find the cities and rooms that fit an artist",
      description:
        "For an artist, manager or booking agent planning shows: given an artist and up to 5 cities, ranks the cities by Qloo's affinity for the artist there and lists the live music venues and concert halls in each whose visitors' taste fits the artist's fans. Cities need their state or country, e.g. 'Austin, Texas'. Qloo knows taste, not capacity or availability.",
      inputSchema: z.object({
        artist: named.describe("The artist, by name as Qloo knows it, or {name, id}"),
        cities: z.array(z.string().min(2).max(MAX_NAME)).min(1).max(MAX_CITIES).describe("Cities with their state or country"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return await limited(async (budget) => {
          const input = artistInput(args);
          const r = await cached(env, budget, "artist", { a: input.artist, c: input.cities }, () => forArtist(env, budget, input));
          const s = tourSummary(r);
          const notes = caveats(r);
          return { content: [{ type: "text" as const, text: notes ? `${s}\n\n${notes}` : s }], structuredContent: { spoken: s, ...r } };
        });
      } catch (e) {
        return { content: [{ type: "text" as const, text: failure(e).message }], isError: true };
      }
    },
  );
  return server;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return createMcpHandler(() => buildServer(env, req)).fetch(req);
    if (url.pathname === "/favicon.ico") return Response.redirect(new URL("/favicon.svg", url).toString(), 301);
    if (url.pathname === "/api/status") return json({ qloo: !!env.QLOO_API_KEY });
    if (url.pathname === "/api/venue" && req.method === "POST") {
      const input = venueInput(await req.json().catch(() => null));
      if (input.venue.name.length < 2 || !input.acts.length) return json({ error: "Name your venue with its city, and at least one act that did well there." }, 400);
      const budget = new Budget(REQUEST_BUDGET);
      if (!(await allow(req, "venue", LIMITS.venue, budget))) return json({ error: "Too many searches from this address in the last hour. Please try again later." }, 429);
      try {
        const r = await cached(env, budget, "venue", { v: input.venue, a: input.acts, p: input.pitches, r: input.rising }, () => forVenue(env, budget, input));
        return json({ ...r, summary: venueSummary(r), leftOut: input.leftOut });
      } catch (e) {
        const f = failure(e);
        return json({ error: f.message }, f.status);
      }
    }
    if (url.pathname === "/api/artist" && req.method === "POST") {
      const input = artistInput(await req.json().catch(() => null));
      if (input.artist.name.length < 1 || !input.cities.length) return json({ error: "Name the artist and at least one city." }, 400);
      const budget = new Budget(REQUEST_BUDGET);
      if (!(await allow(req, "artist", LIMITS.artist, budget))) return json({ error: "Too many searches from this address in the last hour. Please try again later." }, 429);
      try {
        const r = await cached(env, budget, "artist", { a: input.artist, c: input.cities }, () => forArtist(env, budget, input));
        return json({ ...r, summary: tourSummary(r), leftOut: input.leftOut });
      } catch (e) {
        const f = failure(e);
        return json({ error: f.message }, f.status);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
