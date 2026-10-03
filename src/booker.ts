// Booker's two pipelines. For a venue: which acts fit this room's crowd and size, which pitches in the
// inbox fit, and bills that pair a headliner with an opener whose fans overlap. For an artist or agent:
// which cities like the act most, and which rooms there fit it. Every Qloo call is recorded for the
// page's "How we know" panel; Booker's own rules are listed apart from Qloo's numbers.

import { AppError, type Budget } from "./limits.ts";
import { Qloo, QlooError, type Entity, type QlooEnv } from "./qloo.ts";
import { nameKey, resolveArtist, resolveChosen, resolveVenue, type Choice, type Resolved } from "./resolve.ts";
import { cityCenter, km } from "./geo.ts";

export interface Named {
  name: string;
  id?: string; // a Qloo ID picked from the alternatives of an earlier answer
}

export interface Pick {
  input: string;
  name: string;
  id: string;
  match: Resolved["match"];
  alternatives: Choice[];
  popularity?: number;
  genres?: string[];
}

export interface Candidate {
  name: string;
  id: string;
  popularity?: number;
  affinity?: number; // Qloo's affinity to your acts (and your city, when it could be used)
  genres?: string[];
  closest?: { name: string; affinity: number }; // the act of yours whose fans like it most
}

export interface Verdict extends Pick {
  affinity?: number;
  verdict: "fits" | "bigger" | "smaller" | "off-taste" | "unscored";
  why: string;
}

export interface Trace {
  trace: { step: string; detail: string }[];
  calls: QlooCall[];
  ours: string[];
  limits: string[];
  degraded: boolean; // an optional step failed: shown, but not cached
  computedAt: number;
}
type QlooCall = { path: string; params: Record<string, string>; status: number; ms: number; count: number };

export interface VenueResult extends Trace {
  mode: "venue";
  venue: Pick & { address?: string; city?: string; lat?: number; lon?: number; categories?: string[] };
  acts: Pick[];
  unresolved: string[];
  band?: { min: number; max: number }; // the popularity range of the acts that did well here
  city?: string; // the city Qloo was asked about, when it could be used
  qlooCity?: string; // the locality Qloo matched, in Qloo's words
  fits: Candidate[];
  openers: Candidate[];
  bills: { headliner: string; opener: string; overlap: number }[];
  inbox: Verdict[];
  roomFans: Candidate[]; // Qloo's view of the venue's own fans
  rivals: { act: string; rooms: { name: string; affinity?: number; you: boolean }[] }; // rooms in town that fit the top act
}

export interface TourResult extends Trace {
  mode: "artist";
  artist: Pick;
  cities: {
    input: string;
    label: string;
    lat: number;
    lon: number;
    qlooCity?: string;
    affinity?: number; // how much the city's taste likes the act (Qloo)
    rooms: { name: string; id: string; address?: string; lat?: number; lon?: number; affinity?: number; categories?: string[] }[];
  }[];
  notFound: string[];
}

const pick = (r: Resolved): Pick => ({
  input: r.input,
  name: r.entity.name,
  id: r.entity.id,
  match: r.match,
  alternatives: r.alternatives,
  ...(r.entity.popularity !== undefined ? { popularity: r.entity.popularity } : {}),
  ...(r.entity.genres?.length ? { genres: r.entity.genres } : {}),
});

const candidate = (e: Entity): Candidate => ({
  name: e.name,
  id: e.id,
  ...(e.popularity !== undefined ? { popularity: e.popularity } : {}),
  ...(e.affinity !== undefined ? { affinity: e.affinity } : {}),
  ...(e.genres?.length ? { genres: e.genres } : {}),
});

// Errors that mean "this one name isn't in Qloo"; anything else stops the search with its real message.
const notFound = (e: unknown) => e instanceof AppError && (e.status === 400 || e.status === 404);

async function resolveArtists(q: Qloo, names: Named[]): Promise<{ found: Resolved[]; missing: string[]; same: string[] }> {
  const out = await Promise.all(
    names.map((n) =>
      (n.id ? resolveChosen(q, n.name, n.id) : resolveArtist(q, n.name)).catch((e) => {
        if (notFound(e)) return null;
        throw e;
      }),
    ),
  );
  const found: Resolved[] = [];
  const missing: string[] = [];
  const same: string[] = []; // "Black Angels" when "The Black Angels" was already named: one act, counted once
  out.forEach((r, i) => {
    if (!r) missing.push(names[i].name);
    else if (found.some((f) => f.entity.id === r.entity.id)) same.push(nameKey(names[i].name) === nameKey(r.entity.name) ? r.entity.name : `${names[i].name} (${r.entity.name})`);
    else found.push(r);
  });
  return { found, missing, same };
}
const twice = (same: string[]) => (same.length ? `; the same act named twice: ${same.join(", ")}` : "");

// The city Qloo is asked about, spelled out the way it resolves (measured: "Chicago, Illinois",
// "Portland, Maine", "Berlin, Germany"; a US or Canadian city with its state or province).
export function cityOf(e: Entity): string | undefined {
  if (!e.city) return undefined;
  const region = e.countryCode === "US" || e.countryCode === "CA" ? e.region : e.country;
  return region ? `${e.city}, ${region}` : e.city;
}

const fmt = (n?: number) => (n === undefined ? "?" : n.toFixed(2));
const fmt3 = (n?: number) => (n === undefined ? "?" : n.toFixed(3)); // popularity near 1 needs the third digit
const fmt4 = (n?: number) => (n === undefined ? "?" : n.toFixed(4));
// Size limits are rounded outward to 4 decimals: the numbers Qloo is sent (with 3, the widening above
// 0.997 rounded away, and above 0.9995 the top limit became 1) are the numbers the inbox is judged by.
const down4 = (x: number) => Math.floor(x * 1e4) / 1e4;
const up4 = (x: number) => Math.ceil(x * 1e4) / 1e4;

// Qloo's popularity is a percentile and bunches up near 1: in the rooms we checked, 0.98 and 0.99 were
// clubs and theaters apart (100-300 cap acts 0.35-0.55, 300-800 cap 0.90-0.97, theaters 0.98-0.99). It is
// Qloo's own measure, not capacity or ticket sales (Morgan Wallen, a stadium act, is 0.968), so the size
// verdicts are a guide. Sizes are compared on -log10(1 - p), where each step of 1 is ten times rarer, and
// widened by 0.1 on that scale; the cap only keeps p = 1 finite.
export const sizeOf = (p: number) => -Math.log10(1 - Math.min(p, 0.99999));
export const fromSize = (s: number) => 1 - 10 ** -s;
const WIDEN = 0.1;
const TASTE_GAP = 0.09;

export async function forVenue(
  env: QlooEnv,
  budget: Budget,
  input: { venue: Named; acts: Named[]; pitches: Named[]; rising: boolean },
): Promise<VenueResult> {
  const q = new Qloo(env, budget);
  const trace: Trace["trace"] = [];
  let degraded = false;
  if (!env.QLOO_API_KEY) throw new QlooError("The Qloo API key has not been configured yet.", 503);

  // 1. The room and the acts that did well there.
  const [venueR, actsR] = await Promise.all([
    (input.venue.id ? resolveChosen(q, input.venue.name, input.venue.id) : resolveVenue(q, input.venue.name)).catch((e) => {
      if (notFound(e)) return null;
      throw e;
    }),
    resolveArtists(q, input.acts),
  ]);
  if (!venueR) throw new AppError(`I couldn't find "${input.venue.name}" among Qloo's music venues. Try its name and city, like "The Empty Bottle, Chicago".`, 404);
  const v = venueR.entity;
  trace.push({ step: "Venue", detail: `${v.name}${v.address ? `, ${v.address}` : ""} (Qloo place; ${(v.categories ?? []).join(", ") || "no category"})` });
  if (!actsR.found.length)
    throw new AppError("None of those acts are in Qloo. Name artists that played your room and sold well.", 422);
  const acts = actsR.found;
  const actIds = acts.map((a) => a.entity.id);
  trace.push({
    step: "Your acts",
    detail: `${acts.length} of ${input.acts.length} matched in Qloo${actsR.missing.length ? `; not found: ${actsR.missing.join(", ")}` : ""}${twice(actsR.same)}`,
  });

  // 2. Size: the popularity range of the acts that did well here (Booker's rule). A room's crowd is
  // measured by what it already drew, not by a guess about capacity.
  const pops = acts.map((a) => a.entity.popularity).filter((p): p is number => p !== undefined);
  const band = pops.length ? { min: Math.min(...pops), max: Math.max(...pops) } : undefined;
  const fitsMin = band ? down4(fromSize(Math.max(0, sizeOf(band.min) - WIDEN))) : undefined;
  const fitsMax = band ? up4(fromSize(sizeOf(band.max) + WIDEN)) : undefined;
  const openersMax = fitsMin !== undefined && fitsMin > 0.15 ? fitsMin : undefined;
  trace.push({
    step: "Size",
    detail: band
      ? `Your acts sit between ${fmt3(band.min)} and ${fmt3(band.max)} on Qloo's popularity scale; acts that fit are looked for in ${fmt4(fitsMin)} to ${fmt4(fitsMax)}, openers below ${fmt4(openersMax)}`
      : "Qloo gave no popularity for your acts, so size isn't filtered",
  });

  // 3. Acts that fit: liked by the fans of your acts, in your city, at your size.
  let city = cityOf(v);
  let qlooCity: string | undefined;
  const ask = async (o: Parameters<Qloo["artists"]>[0]) => {
    try {
      const r = await q.artists({ ...o, city });
      if (r.locality && !qlooCity) qlooCity = r.locality.name;
      // Seen live: a small town (Indian Hills, for Red Rocks) resolves but returns nothing at all. Ask again
      // without it, and say so, rather than report that nothing fits the room's size.
      if (!r.list.length && city && !o.only) {
        const plain = (await q.artists({ ...o, city: undefined })).list;
        if (plain.length) {
          trace.push({ step: "City", detail: `Qloo had no answers with "${city}" as a signal, so the city isn't part of the ranking` });
          city = undefined;
          qlooCity = undefined;
          return plain;
        }
      }
      return r.list;
    } catch (e) {
      // Measured: Qloo answers 400 when it can't resolve the city; ask again without it, and say so.
      if (e instanceof QlooError && e.code === "locality" && city) {
        trace.push({ step: "City", detail: `Qloo couldn't place "${city}", so the city isn't part of the ranking` });
        city = undefined;
        return (await q.artists({ ...o, city: undefined })).list;
      }
      throw e;
    }
  };
  let fits = (await ask({ entities: actIds, popMin: fitsMin, popMax: fitsMax, exclude: actIds, rising: input.rising, take: 12 })).map(candidate);
  if (!fits.length && fitsMin !== undefined) {
    fits = (await ask({ entities: actIds, popMin: down4(fromSize(Math.max(0, sizeOf(fitsMin) - WIDEN))), popMax: fitsMax, exclude: actIds, rising: input.rising, take: 12 })).map(candidate);
    trace.push({ step: "Size", detail: "Nothing in that range, so it was widened one more step below" });
  }
  const openers = openersMax === undefined ? [] : (await ask({ entities: actIds, popMax: openersMax, exclude: actIds, rising: input.rising, take: 8 })).map(candidate).filter((o) => !fits.some((f) => f.id === o.id));
  trace.push({
    step: "Shortlist",
    detail: `Qloo ranked ${fits.length} acts that fit and ${openers.length} openers for fans of your acts${city ? ` in ${qlooCity ?? city}` : ""}${input.rising ? ", favoring rising acts (Qloo trends)" : ""}`,
  });

  // 4. Why: for each candidate, the act of yours whose fans like it most (one call per act, up to 4).
  const shortlist = [...fits, ...openers].slice(0, 20);
  if (shortlist.length) {
    for (const a of acts.slice(0, 4)) {
      try {
        const scored = (await q.artists({ entities: [a.entity.id], only: shortlist.map((c) => c.id), take: shortlist.length })).list;
        for (const s of scored) {
          const c = shortlist.find((x) => x.id === s.id);
          if (c && s.affinity !== undefined && (!c.closest || s.affinity > c.closest.affinity)) c.closest = { name: a.entity.name, affinity: s.affinity };
        }
      } catch {
        degraded = true;
      }
    }
    trace.push({ step: "Why", detail: `Scored the shortlist against ${Math.min(4, acts.length)} of your acts one by one, to name the closest` });
  }

  // 5. Bills: each of the top three acts with the opener whose fans overlap most (Qloo affinity).
  const bills: VenueResult["bills"] = [];
  const usedOpeners = new Set<string>();
  for (const h of fits.slice(0, openers.length ? 3 : 0)) {
    try {
      const scored = (await q.artists({ entities: [h.id], only: openers.map((o) => o.id), take: openers.length })).list
        .filter((s) => s.affinity !== undefined && !usedOpeners.has(s.id))
        .sort((a, b) => b.affinity! - a.affinity!);
      if (scored[0]) {
        usedOpeners.add(scored[0].id);
        bills.push({ headliner: h.name, opener: scored[0].name, overlap: scored[0].affinity! });
      }
    } catch {
      degraded = true;
    }
  }
  if (bills.length) trace.push({ step: "Bills", detail: `Paired ${bills.length} of the top acts with the opener whose fans overlap most` });

  // 6. The inbox: acts that pitched you, scored against the same crowd and size.
  const inbox: Verdict[] = [];
  if (input.pitches.length) {
    const p = await resolveArtists(q, input.pitches);
    // Scored by taste alone: with the city as a signal Qloo leaves some artists out (measured). Three of
    // Qloo's own picks for this crowd are scored in the same call as a yardstick.
    // When a top pick is itself a pitch, the next pick stands in (the openers if no fit is left); with no
    // picks at all, taste isn't judged.
    const unpitched = (c: Candidate) => !p.found.some((r) => r.entity.id === c.id);
    const refs = (fits.some(unpitched) ? fits : openers).filter(unpitched).slice(0, 3).map((c) => c.id);
    const ids = [...p.found.map((r) => r.entity.id), ...refs];
    const scored = p.found.length ? (await q.artists({ entities: actIds, only: ids, take: ids.length })).list : [];
    // Taste floor (Booker's rule): more than 0.09 below the yardstick isn't your crowd's taste. Set from
    // 10 live pitches at 4 rooms (2026-10-03): fits sat 0.045-0.074 below (Wet Leg at Mohawk, Kingfish at
    // Antone's, Beach House at the Bowery), clear misses 0.102-0.164 below (Morgan Wallen at Mohawk, Bad
    // Bunny at the Bowery, Black Pumas at Antone's, Turnpike Troubadours at the Empty Bottle).
    const refAff = scored.filter((x) => refs.includes(x.id)).map((x) => x.affinity).filter((a): a is number => a !== undefined);
    const floor = refAff.length ? Math.min(...refAff) - TASTE_GAP : undefined;
    for (const r of p.found) {
      const s = scored.find((x) => x.id === r.entity.id);
      const pop = r.entity.popularity;
      const aff = s?.affinity;
      let verdict: Verdict["verdict"] = "fits";
      let why = `Fans of your acts like them (${fmt(aff)})${pop !== undefined && band ? ` and they're your size (${fmt3(pop)})` : ""}`;
      if (aff === undefined) {
        verdict = "unscored";
        why = "Qloo gave no score for them with your acts";
      } else if (floor === undefined) {
        verdict = "unscored";
        why = `Fans of your acts score them ${fmt(aff)}, but Qloo had no picks of its own to compare with, so taste isn't judged`;
      } else if (aff < floor) {
        verdict = "off-taste";
        why = `Your crowd's taste is elsewhere: ${fmt(aff)}, below ${fmt(floor)}`;
      } else if (band && pop !== undefined && fitsMax !== undefined && pop > fitsMax) {
        verdict = "bigger";
        why = `Bigger than your room has drawn (${fmt3(pop)} vs your ${fmt3(band.min)} to ${fmt3(band.max)}); taste fits (${fmt(aff)})`;
      } else if (band && pop !== undefined && fitsMin !== undefined && pop < fitsMin) {
        verdict = "smaller";
        why = `Smaller than your usual acts (${fmt3(pop)}); taste fits (${fmt(aff)}): an opener or an off night`;
      }
      inbox.push({ ...pick(r), ...(aff !== undefined ? { affinity: aff } : {}), verdict, why });
    }
    const order = { fits: 0, smaller: 1, bigger: 2, "off-taste": 3, unscored: 4 };
    inbox.sort((a, b) => order[a.verdict] - order[b.verdict] || (b.affinity ?? 0) - (a.affinity ?? 0));
    for (const m of p.missing) inbox.push({ input: m, name: m, id: "", match: "closest", alternatives: [], verdict: "unscored", why: "Not found in Qloo" });
    trace.push({
      step: "Inbox",
      detail: `Scored ${p.found.length} pitches against your acts, ${floor === undefined ? "with none of Qloo's picks to compare with (taste not judged)" : `next to ${refAff.length} of Qloo's picks as a yardstick (taste floor ${fmt(floor)})`}${p.missing.length ? `; not found: ${p.missing.join(", ")}` : ""}${twice(p.same)}`,
    });
  }

  // 7. Context: what Qloo says the room's own fans like, and the rooms in town that fit the top act.
  let roomFans: Candidate[] = [];
  try {
    roomFans = (await q.artists({ entities: [v.id], popMin: fitsMin, popMax: fitsMax, exclude: actIds, take: 6 })).list.map(candidate);
  } catch {
    degraded = true;
  }
  const rivals: VenueResult["rivals"] = { act: "", rooms: [] };
  if (fits[0] && city) {
    try {
      const rooms = await q.venues([fits[0].id], city, 6);
      rivals.act = fits[0].name;
      rivals.rooms = rooms.map((r) => ({ name: r.name, ...(r.affinity !== undefined ? { affinity: r.affinity } : {}), you: r.id === v.id }));
      trace.push({ step: "Rivals", detail: `Asked Qloo which rooms in ${city} fit ${fits[0].name}'s fans${rooms.some((r) => r.id === v.id) ? "; yours is among them" : ""}` });
    } catch {
      degraded = true;
    }
  }

  return {
    mode: "venue",
    venue: {
      ...pick(venueR),
      ...(v.address ? { address: v.address } : {}),
      ...(cityOf(v) ? { city: cityOf(v) } : {}), // where the room is, even if Qloo couldn't use the city as a signal
      ...(v.lat !== undefined && v.lon !== undefined ? { lat: v.lat, lon: v.lon } : {}),
      ...(v.categories?.length ? { categories: v.categories } : {}),
    },
    acts: acts.map(pick),
    unresolved: actsR.missing,
    ...(band ? { band } : {}),
    ...(city ? { city } : {}),
    ...(qlooCity ? { qlooCity } : {}),
    fits,
    openers,
    bills,
    inbox,
    roomFans,
    rivals,
    trace,
    calls: q.calls,
    ours: [
      "Size comes from your own history: acts that fit sit in the popularity range of the acts you named, widened one step (0.1 on a log scale, since 0.98 and 0.99 are clubs and theaters apart); openers sit below it.",
      "The closest act of yours is the one whose fans give the candidate the highest Qloo affinity (your first four acts are compared).",
      "A bill pairs one of the top three acts with the opener whose fans overlap most; each opener is used once.",
      ...(input.pitches.length
        ? ["A pitch is off your crowd's taste when its affinity is more than 0.09 below the lowest of three of Qloo's picks for your crowd (ones you didn't pitch), scored in the same call (set from live pitches at four rooms); bigger or smaller compares its popularity with the range above."]
        : []),
    ],
    limits: [
      "Qloo measures taste: what fans of your acts also like. It doesn't know ticket prices, routing, fees or who is on tour.",
      "Popularity is Qloo's measure across all artists, not ticket sales or capacity (a stadium country act scored 0.968, inside a rock club's range): your own acts set the scale, and the size verdicts are a guide.",
      "The city is part of the ranking when Qloo can place it (cities work; neighborhoods don't, measured).",
    ],
    degraded,
    computedAt: Date.now(),
  };
}

export async function forArtist(
  env: QlooEnv & { CACHE: KVNamespace },
  budget: Budget,
  input: { artist: Named; cities: string[] },
): Promise<TourResult> {
  const q = new Qloo(env, budget);
  const trace: Trace["trace"] = [];
  if (!env.QLOO_API_KEY) throw new QlooError("The Qloo API key has not been configured yet.", 503);
  const { found, missing } = await resolveArtists(q, [input.artist]);
  if (!found[0]) throw new AppError(`I couldn't find "${missing[0] ?? input.artist.name}" among Qloo's artists.`, 404);
  const a = found[0].entity;
  trace.push({ step: "Artist", detail: `${a.name}${a.genres?.length ? ` (${a.genres.join(", ")})` : ""}, Qloo popularity ${fmt(a.popularity)}` });

  const notFoundCities: string[] = [];
  const cities: TourResult["cities"] = [];
  for (const text of input.cities) {
    const c = await cityCenter(env.CACHE, budget, text);
    if (!c) {
      notFoundCities.push(text);
      continue;
    }
    let affinity: number | undefined;
    let qlooCity: string | undefined;
    try {
      // How much this city's taste likes the act: the act alone, scored with the city as the signal.
      const r = await q.artists({ entities: [], city: c.query, only: [a.id], take: 1 });
      affinity = r.list.find((x) => x.id === a.id)?.affinity;
      if (r.locality) {
        qlooCity = r.locality.name;
        if (km(r.locality, c) > 60) {
          trace.push({ step: "Check", detail: `Qloo read "${c.query}" as ${r.locality.name}, ${Math.round(km(r.locality, c))} km away; this city is left out` });
          notFoundCities.push(text);
          continue;
        }
      }
    } catch (e) {
      if (!(e instanceof QlooError && e.code === "locality")) throw e;
      notFoundCities.push(text);
      continue;
    }
    const rooms = await q.venues([a.id], c.query, 6);
    cities.push({
      input: text,
      label: c.name,
      lat: c.lat,
      lon: c.lon,
      ...(qlooCity ? { qlooCity } : {}),
      ...(affinity !== undefined ? { affinity } : {}),
      rooms: rooms.map((r) => ({
        name: r.name,
        id: r.id,
        ...(r.address ? { address: r.address } : {}),
        ...(r.lat !== undefined && r.lon !== undefined ? { lat: r.lat, lon: r.lon } : {}),
        ...(r.affinity !== undefined ? { affinity: r.affinity } : {}),
        ...(r.categories?.length ? { categories: r.categories } : {}),
      })),
    });
  }
  if (!cities.length) throw new AppError("None of those cities could be placed. Try a city with its state or country, like \"Austin, Texas\".", 400);
  cities.sort((x, y) => (y.affinity ?? -1) - (x.affinity ?? -1));
  trace.push({ step: "Cities", detail: `Scored ${a.name} in ${cities.length} cities with the city as Qloo's signal${notFoundCities.length ? `; not placed: ${notFoundCities.join(", ")}` : ""}` });
  trace.push({ step: "Rooms", detail: `Asked Qloo for the live music venues and concert halls in each city whose visitors' taste fits ${a.name}'s fans` });

  return {
    mode: "artist",
    artist: pick(found[0]),
    cities,
    notFound: notFoundCities,
    trace,
    calls: q.calls,
    ours: ["Cities are ordered by Qloo's affinity for the act there; a city Qloo has no score for comes last."],
    limits: [
      "Qloo measures taste, not capacity, fees or availability: check that a room's size fits before you pitch it.",
      "Rooms are the places Qloo tags as live music venues or concert halls; a few are record stores, cafés or arts spaces that host shows.",
      "A city's score compares the act with everything that city likes; it is a relative signal, not a ticket forecast.",
    ],
    degraded: false,
    computedAt: Date.now(),
  };
}
