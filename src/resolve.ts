// Names typed by a person become Qloo entities the way Qloo's official harness resolves them: an exact
// name is preferred. Qloo's search returns something for almost any text, so a candidate that isn't
// the exact name is used only if it resembles what was typed; the answer says so and offers the others.

import { Qloo, normalizeName, type Entity } from "./qloo.ts";

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

const STOP = new Set(["the", "a", "an", "of", "and", "&"]);
const words = (s: string) => normalizeName(s).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
// "The Empty Bottle" and "Empty Bottle" are the same name; so are "Snail Mail" and "snail mail".
export const nameKey = (s: string) => words(s).join(" ");

function typoDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

// One contains the other, or at least half the typed words appear, allowing a typo or two.
export function resembles(typed: string, name: string): boolean {
  const a = words(typed), b = words(name);
  if (!a.length || !b.length) return false;
  const A = a.join(" "), B = b.join(" ");
  if (A === B || B.includes(A) || A.includes(B)) return true;
  const close = (w: string) => b.some((x) => x === w || typoDistance(w, x) <= (w.length > 5 ? 2 : w.length > 3 ? 1 : 0));
  return a.filter(close).length / a.length >= 0.5;
}

const label = (e: Entity) => (e.disambiguation && nameKey(e.disambiguation) !== nameKey(e.name) ? `${e.name} (${e.disambiguation})` : e.name);

// Artists: 5 candidates, like the harness.
export async function resolveArtist(q: Qloo, input: string): Promise<Resolved | null> {
  const found = (await q.search(input, "urn:entity:artist", 5)).filter((e) => e.types.includes("urn:entity:artist") || !e.types.length);
  const exact = found.filter((e) => nameKey(e.name) === nameKey(input));
  const list = found.filter((e) => exact.includes(e) || resembles(input, e.name));
  if (!list.length) return null;
  const pick = exact[0] ?? list[0];
  return {
    input,
    entity: pick,
    match: exact.length === 1 ? "exact" : exact.length > 1 ? "ambiguous" : "closest",
    alternatives: list.filter((e) => e.id !== pick.id).slice(0, 4).map((e) => ({ id: e.id, name: label(e), note: e.genres?.[0] })),
  };
}

// A place counts as a room if Qloo files it as a music venue, a theater, or a bar or club where small
// shows happen (categories measured on Qloo place records); golf, country and health clubs don't.
const ROOM = /\b(live music|concert hall|music venue|night ?club|jazz club|event venue|performing arts theater|theater|theatre|amphitheater|auditorium|bar|pub|lounge|club)\b/i;
const NOT_ROOM = /\b(golf|country club|health club|fitness|gym|tennis|yacht|swim|athletic|sports club)\b/i;
const MUSIC = /\b(live music|concert hall|music venue|jazz club|night ?club)\b/i;
export const isRoom = (e: Entity) => {
  const cats = e.categories ?? [];
  return cats.some((c) => ROOM.test(c)) && (cats.some((c) => MUSIC.test(c)) || !cats.some((c) => NOT_ROOM.test(c)));
};
const musicFirst = (a: Entity, b: Entity) => Number((b.categories ?? []).some((c) => MUSIC.test(c))) - Number((a.categories ?? []).some((c) => MUSIC.test(c)));

// Venues: "The Empty Bottle, Chicago". The whole text goes to Qloo's place search (the city helps it);
// the name part (before the comma) decides exact or closest.
export async function resolveVenue(q: Qloo, input: string): Promise<Resolved | null> {
  const name = input.split(",")[0].trim();
  // Among places with the same name, one Qloo files as a music venue comes first (stable otherwise).
  const found = (await q.search(input.replace(/,/g, " "), "urn:entity:place", 8)).filter(isRoom).sort(musicFirst);
  const exact = found.filter((e) => nameKey(e.name) === nameKey(name) || nameKey(e.name).startsWith(nameKey(name) + " "));
  const list = found.filter((e) => exact.includes(e) || resembles(name, e.name));
  if (!list.length) return null;
  const pick = exact[0] ?? list[0];
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
