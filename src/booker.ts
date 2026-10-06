// Booker's two pipelines. For a venue: which acts fit this room's crowd and size, which pitches in the
// inbox fit, and bills that pair a headliner with an opener whose fans overlap. For an artist or agent:
// which cities like the act most, and which rooms there fit it. Every Qloo call is recorded for the
// page's "How we know" panel; Booker's own rules are listed apart from Qloo's numbers.

import { AppError, type Budget } from "./limits.ts";
import { Qloo, QlooError, type Entity, type QlooEnv, type Where } from "./qloo.ts";
import { nameKey, resolveArtist, resolveChosen, resolveVenue, type Choice, type Resolved } from "./resolve.ts";
import { cityCenter, km } from "./geo.ts";
import { MAX_ACTS, MAX_PITCHES } from "./input.ts";

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
  rivals: { act: string; rooms: { name: string; affinity?: number; you: boolean; categories?: string[] }[] }; // rooms in town that fit the top act
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
    note?: string; // how a city was read when what followed its comma didn't match it
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

// spare: the calls the rest of the search still needs, kept back from second searches for names with a note.
export async function resolveArtists(q: Qloo, names: Named[], max = 0, spare?: number): Promise<{ found: Resolved[]; missing: string[]; same: string[]; split: string[] }> {
  const one = (n: Named) =>
    (n.id ? resolveChosen(q, n.name, n.id) : resolveArtist(q, n.name, spare)).catch((e) => {
      if (notFound(e)) return null;
      throw e;
    });
  let out: { name: string; id?: string; r: Resolved | null }[] = await Promise.all(names.map(async (n) => ({ name: n.name, id: n.id, r: await one(n) })));
  // Two acts joined in a list ("Big Thief, Waxahatchee & Snail Mail"): when the joined name isn't an exact
  // match, or matched only one of the two, and each part is an exact match on its own, both are used. At most
  // twice per search, for the call budget, and never past `max` names (0: never, as for the one artist of a
  // tour); "Simon & Garfunkel" and "Earth, Wind & Fire" stay one act.
  const split: string[] = [];
  let tries = 0;
  for (let i = 0; i < out.length && tries < 2 && out.length < max; i++) {
    const { name, id, r } = out[i];
    const join = [...name.matchAll(/\s+(?:&|and|\+)\s+/gi)].pop();
    if (id || !join || r?.match === "exact") continue;
    const parts = [name.slice(0, join.index), name.slice(join.index! + join[0].length)].map((x) => x.trim());
    // Tried only when the joined name found nothing or fell to one of its parts ("Mumford & Son" already
    // reached Mumford & Sons), so a try isn't spent where a split can't help.
    if (parts.some((x) => x.length < 2) || (r && !parts.some((x) => nameKey(x) === nameKey(r.entity.name)))) continue;
    tries++;
    const both = await Promise.all(parts.map((x) => one({ name: x })));
    if (both.every((b) => b?.match === "exact") && (!r || both.some((b) => b!.entity.id === r.entity.id))) {
      out = [...out.slice(0, i), ...both.map((b, k) => ({ name: parts[k], r: b })), ...out.slice(i + 1)];
      split.push(name);
    }
  }
  const found: Resolved[] = [];
  const missing: string[] = [];
  const same: string[] = []; // "Black Angels" when "The Black Angels" was already named: one act, counted once
  for (const { name, r } of out) {
    if (!r) missing.push(name);
    else if (found.some((f) => f.entity.id === r.entity.id)) same.push(nameKey(name) === nameKey(r.entity.name) ? r.entity.name : `${name} (${r.entity.name})`);
    else found.push(r);
  }
  return { found, missing, same, split };
}
const readAsTwo = (split: string[]) => (split.length ? `; read as two acts: ${split.join(", ")}` : "");
const twice = (same: string[]) => (same.length ? `; the same act named twice: ${same.join(", ")}` : "");

// The city Qloo is asked about, spelled out the way it resolves (measured: "Chicago, Illinois",
// "Portland, Maine", "Berlin, Germany"; a US or Canadian city with its state or province).
export function cityOf(e: Entity): string | undefined {
  if (!e.city) return undefined;
  // UK places with their nation: Qloo reads "Bangor, Wales" right and "Bangor, United Kingdom" as Northern Ireland.
  const region = e.countryCode === "US" || e.countryCode === "CA" || (e.countryCode === "GB" && e.region) ? e.region : e.country;
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

// Qloo's rooms for an act are places it tags as live music venues or concert halls, so all carry a music
// category somewhere; for bigger acts some are mainly something else (live: Handel Hendrix House, a museum; the
// ICA and Dulwich Picture Gallery, galleries; a flea market). Qloo lists a place's main uses first, so a room
// is left out when its first two categories hold no show category and its first four (or its name) say
// museum, gallery, flea market or film studio. The Ryman ("Museum, Performing arts theater"), the Cavern Club,
// The Old Bar and the Barbican (an art gallery only tenth) stay.
// Twelve are asked for, six kept in Qloo's order, never leaving out the venue's own room.
const SHOW_CATEGORY = /\b(live music|music venue|night ?club|jazz club|concert hall|bar|pub|lounge|performing arts|auditorium|amphitheat(er|re)|arena|stage)\b/i;
const MAINLY_ELSE = /\b(museum|gallery|flea market|film production)\b/i;
// A name saying housing wins over the categories (Westbeth Artists Housing is filed first as an art center and
// a live music venue); a name saying museum or gallery counts only when the first categories hold no show
// category (Dulwich Picture Gallery yes, The Museum Club, a bar, no). Shops aren't left out: McCabe's Guitar
// Shop ("Guitar store, Musical instrument store, ..., Concert hall") is a famous room.
export const mainlyShows = (r: { name?: string; categories?: string[] }) => {
  const cats = r.categories ?? [];
  if (/\b(housing|apartments)\b/i.test(r.name ?? "")) return false;
  return cats.slice(0, 2).some((c) => SHOW_CATEGORY.test(c)) || !(cats.slice(0, 4).some((c) => MAINLY_ELSE.test(c)) || /\b(museum|gallery)\b/i.test(r.name ?? ""));
};
// A closed room books nothing (Qloo keeps closed places: "CLOSED - Tacos el Cabron" in San Diego, live, with is_closed false).
export function showRooms<T extends { id?: string; name?: string; categories?: string[]; closed?: boolean }>(rooms: T[], keep: number, own?: string): T[] {
  return rooms.filter((r) => r.id === own || (mainlyShows(r) && !r.closed)).slice(0, keep);
}
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
    resolveArtists(q, input.acts, MAX_ACTS),
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
    detail: `${acts.length} of ${input.acts.length + actsR.split.length} matched in Qloo${actsR.missing.length ? `; not found: ${actsR.missing.join(", ")}` : ""}${twice(actsR.same)}${readAsTwo(actsR.split)}`,
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
  let cityAnswered = false; // the city has already shaped a ranking
  let openersWithoutCity = false;
  const ask = async (o: Parameters<Qloo["artists"]>[0]) => {
    try {
      const r = await q.artists({ ...o, city });
      if (r.locality && !qlooCity) qlooCity = r.locality.name;
      if (r.list.length && city) cityAnswered = true;
      // Seen live: a small town (Indian Hills, for Red Rocks) resolves but returns nothing at all. Ask again
      // without it, and say so, rather than report that nothing fits the room's size. If the city already
      // shaped the acts that fit, only this list is asked without it.
      if (!r.list.length && city && !o.only) {
        const plain = (await q.artists({ ...o, city: undefined })).list;
        if (plain.length) {
          if (cityAnswered) {
            if (o.popMin === undefined) openersWithoutCity = true;
            trace.push({ step: "City", detail: `Qloo had no ${o.popMin === undefined ? "openers" : "acts"} for this with "${city}" as a signal, so those are ranked without the city` });
          } else {
            trace.push({ step: "City", detail: `Qloo had no answers with "${city}" as a signal, so the city isn't part of the ranking` });
            city = undefined;
            qlooCity = undefined;
          }
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
    detail: `Qloo ranked ${n(fits.length, "act", "acts")} that fit${city && openersWithoutCity ? ` in ${qlooCity ?? city}` : ""} and ${n(openers.length, "opener", "openers")} for fans of your acts${city && !openersWithoutCity ? ` in ${qlooCity ?? city}` : ""}${input.rising ? ", favoring rising acts (Qloo trends)" : ""}`,
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
    // Pitches come last: only the score, room fans, rivals and the cache write follow (4 calls, and room for retries).
    const p = await resolveArtists(q, input.pitches, MAX_PITCHES, 8);
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
      detail: `Scored ${n(p.found.length, "pitch", "pitches")} against your acts, ${floor === undefined ? "with none of Qloo's picks to compare with (taste not judged)" : `next to ${refAff.length} of Qloo's picks as a yardstick (taste floor ${fmt(floor)})`}${p.missing.length ? `; not found: ${p.missing.join(", ")}` : ""}${twice(p.same)}${readAsTwo(p.split)}`,
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
      const rooms = showRooms(await q.venues([fits[0].id], city, 12), 6, v.id);
      rivals.act = fits[0].name;
      rivals.rooms = rooms.map((r) => ({ name: r.name, ...(r.affinity !== undefined ? { affinity: r.affinity } : {}), you: r.id === v.id, ...(r.categories?.length ? { categories: r.categories } : {}) }));
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
  let aroundCentre = 0; // cities asked for by their centre
  for (const text of input.cities) {
    const c = await cityCenter(env.CACHE, budget, text);
    if (!c) {
      notFoundCities.push(text);
      continue;
    }
    // The same city typed twice ("Chicago, Illinois" and "chicago") is scored once.
    const again = cities.find((x) => km(x, c) < 2);
    if (again) {
      trace.push({ step: "Check", detail: `"${text}" is the same city as "${again.input}"; it's scored once` });
      continue;
    }
    let affinity: number | undefined;
    let qlooCity: string | undefined;
    let where: Where = c.query;
    let found: Entity[] | undefined; // the rooms of the circle around the city, when it was asked for
    try {
      // How much this city's taste likes the act: the act alone, scored with the city as the signal.
      const r = await q.artists({ entities: [], city: where, only: [a.id], take: 1 });
      affinity = r.list.find((x) => x.id === a.id)?.affinity;
      if (r.locality) qlooCity = r.locality.name;
      // Qloo can read a city as somewhere else (live: "Honolulu, Hawaii" as Honolulu County, 756 km off; "Istanbul,
      // Republic of Türkiye" as the country; "Boise, Idaho" as Boise County, 56 km), as one part of it ("London, Ontario"
      // as Wortley Village, with no score and 2 rooms; "Tokyo, Japan" as Minato, 5 of 6 rooms there), or give the act no
      // score by the city's name (Moscow, read as its trade fair; Osaka, Nagoya, Fukuoka). The city Booker located is
      // then asked for by a circle around its centre the size of the city, for the score and the rooms alike. A circle can
      // reach across a river or a border, so only rooms Qloo files in the city or its county, in its country, are kept
      // (live: Birkenhead's reached Liverpool's clubs, Ciudad Juárez's El Paso's), and its score is used only when at
      // least half its rooms are the city's own (Union City, NJ, was scored 0.11 higher by Manhattan's). Measured on 26
      // city-act pairs where both answer, the circle's score is within 0.025 of the name's, 0.006 lower on average.
      const off = r.locality ? km(r.locality, c) : 0;
      const part = partOfCity(r.locality, c);
      const misread = off > 50 || !!part;
      if (misread || affinity === undefined) {
        const radiusKm = cityRadiusKm(c.population);
        const circle = { lat: c.lat, lon: c.lon, radiusM: radiusKm * 1000 };
        const around = (await q.artists({ entities: [], city: circle, only: [a.id], take: 1 })).list.find((x) => x.id === a.id)?.affinity;
        const there = await q.venues([a.id], circle, 12);
        const own = there.filter((v) => inCity(v, c));
        const kept = there.filter((v) => inCity(v, c) || inCounty(v, c) || filedNowhere(v));
        const elsewhere = [...new Set(there.filter((v) => !kept.includes(v)).map((v) => (v.city || v.region || v.country || "") + (v.countryCode && c.country && v.countryCode !== c.country ? ` (${v.countryCode})` : "")))].filter(Boolean).slice(0, 2);
        const trusted = own.length > 0 && own.length * 2 >= there.length;
        const why = off > 50 ? `Qloo read "${c.query}" as ${r.locality!.name.split(",").slice(0, 2).join(",")}, ${Math.round(off)} km away` : part ? `Qloo read "${c.query}" as only ${part}, a part of it` : `Qloo gave ${a.name} no score for "${c.query}"${r.locality ? ` (read as ${r.locality.name.split(",")[0]})` : ""}`;
        const leftOut = elsewhere.length ? `; left out ${there.length - kept.length} of its rooms, filed in ${elsewhere.join(" and ")}` : "";
        if (misread || (trusted && around !== undefined)) {
          trace.push({ step: "Check", detail: `${why}; asked again for ${radiusKm} km around the city centre${leftOut}${trusted ? "" : "; most rooms there aren't the city's, so it has no score"}` });
          where = circle;
          found = kept;
          affinity = trusted ? around : undefined;
          qlooCity = undefined;
          aroundCentre++;
        } else
          trace.push({
            step: "Check",
            detail:
              around === undefined
                ? `${why}, nor for ${radiusKm} km around its centre`
                : elsewhere.length
                  ? `${why}; ${radiusKm} km around its centre holds mostly other cities' rooms (${elsewhere.join(" and ")}), so it keeps no score`
                  : `${why}; ${radiusKm} km around its centre has none of its own rooms to go by, so it keeps no score`,
          });
      }
    } catch (e) {
      if (!(e instanceof QlooError && e.code === "locality")) throw e;
      notFoundCities.push(text);
      continue;
    }
    const rooms = showRooms(found ?? (await q.venues([a.id], where, 12)), 6);
    const note = c.unmatched ? `"${text}" was read as ${c.name}; "${c.unmatched}" didn't match its state or country, so check this is the city you meant.` : undefined;
    if (note) trace.push({ step: "Check", detail: note });
    cities.push({
      input: text,
      label: c.name,
      ...(note ? { note } : {}),
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
  // Cities Qloo gave no score are named, not counted as scored (live: "Scored ... in 5 cities" with 3 unscored).
  const unscored = cities.filter((x) => x.affinity === undefined).map((x) => x.input);
  trace.push({
    step: "Cities",
    detail: `Scored ${a.name} in ${n(cities.length - unscored.length, "city", "cities")} with the city as Qloo's signal${aroundCentre ? ` (${aroundCentre} asked as a circle around the centre)` : ""}${unscored.length ? `; no score for ${unscored.map((x) => `"${x}"`).join(", ")}` : ""}${notFoundCities.length ? `; not placed: ${notFoundCities.join(", ")}` : ""}`,
  });
  trace.push({ step: "Rooms", detail: `Asked Qloo for the live music venues and concert halls in each city whose visitors' taste fits ${a.name}'s fans` });

  return {
    mode: "artist",
    artist: pick(found[0]),
    cities,
    notFound: notFoundCities,
    trace,
    calls: q.calls,
    ours: [
      "Cities are ordered by Qloo's affinity for the act there; a city Qloo has no score for comes last.",
      "A city Qloo reads as somewhere else (over 50 km away) or as only a part of it, or where it gives the act no score by the city's name, is scored and searched in a circle around the city's centre sized by its population (3 to 25 km). Only rooms Qloo files in the city or its county, in its country, are kept, and the circle's score is used only when at least half its rooms are the city's own (measured on 26 city-act pairs: within 0.025 of the name's score where both answer, 0.006 lower on average).",
    ],
    limits: [
      "Qloo measures taste, not capacity, fees or availability: check that a room's size fits before you pitch it.",
      "Rooms are the places Qloo tags as live music venues or concert halls, in Qloo's order; a place mainly used as a museum, gallery, flea market, film studio or housing (its first categories or its name say so), or a closed one (Qloo says so, or its name: \"CLOSED - ...\"), is left out. Each room shows its main categories: some are classical halls or arenas, so check that a room books your kind of show.",
      "A city's score compares the act with everything that city likes; it is a relative signal, not a ticket forecast.",
    ],
    degraded: false,
    computedAt: Date.now(),
  };
}

// How far a circle around a city's centre reaches to cover the city: a disc holding its people at about 3,000 per
// km², from 3 to 25 km (Yonkers 5 km, Honolulu 6, Kyoto 12, Moscow 25). Unknown population: 3 km.
export const cityRadiusKm = (population?: number) => Math.min(25, Math.max(3, Math.round(Math.sqrt((population ?? 0) / 3000 / Math.PI))));

// Whether Qloo files a room in the located city (its city, metro or state is named after it: Shibuya's rooms have the
// metro Tokyo, Kadıköy's the province Istanbul), or in the city's own county (Birkenhead's Future Yard is filed under
// Wirral), in the same country. Accents and case don't count ("Ciudad Juárez").
const folded = (s?: string) => nameKey((s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, ""));
const sameCountry = (v: Entity, c: { country?: string }) => !c.country || !v.countryCode || v.countryCode === c.country;
const inCity = (v: Entity, c: { name: string; country?: string }) => {
  const city = folded(c.name.split(",")[0]);
  return sameCountry(v, c) && [v.city, v.metro, v.region].some((n) => !!n && folded(n).includes(city));
};
// A room Qloo files nowhere can't be told apart: it is kept, but doesn't count as the city's own.
const filedNowhere = (v: Entity) => !v.city && !v.metro && !v.region && !v.county;
const inCounty = (v: Entity, c: { country?: string; county?: string }) =>
  !!c.county && sameCountry(v, c) && [v.city, v.county].some((n) => !!n && folded(n).includes(folded(c.county))); // Future Yard's city is "Wirral"

// Qloo can answer a city asked by name with a part of it: "Tokyo, Japan" is Minato ("Minato, Tokyo, ...", one ward)
// and "London, Ontario" Wortley Village ("Wortley Village, London, ...", live). A locality named after the city is the
// city or bigger. The part's name, else null (the same rule as Newcomer's).
function partOfCity(locality: { name: string } | undefined, center: { name: string }): string | null {
  const [own, ...within] = (locality?.name ?? "").split(",").map((x) => nameKey(x));
  const city = nameKey(center.name.split(",")[0]);
  return !own.includes(city) && within.includes(city) ? locality!.name.split(",")[0].trim() : null;
}

// "1 pitch", "2 pitches" (live: "Scored 1 pitches").
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
