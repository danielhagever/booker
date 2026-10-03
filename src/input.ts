// Everything that comes from a visitor or an agent is checked here before it reaches Qloo.

import type { Named } from "./booker.ts";

export const MAX_ACTS = 8;
export const MAX_PITCHES = 8;
export const MAX_CITIES = 5;
export const MAX_NAME = 80;

const TAG_OR_ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validId = (id: string) => TAG_OR_ENTITY_ID.test(id);

export const clean = (v: unknown, max = MAX_NAME): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// A list of names: an array of strings or {name, id} objects, or one text with commas or new lines.
// Splitting never happens on "and": "Simon and Garfunkel" stays one name.
export function names(v: unknown, max: number): { list: Named[]; leftOut: string[] } {
  const raw: unknown[] = typeof v === "string" ? v.split(/[,;\n]+/) : Array.isArray(v) ? v : [];
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

export function cityList(v: unknown): { list: string[]; leftOut: string[] } {
  const raw: unknown[] = typeof v === "string" ? v.split(/[;\n|]+/) : Array.isArray(v) ? v : [];
  const all = [...new Set(raw.map((c) => clean(c)).filter((c) => c.length >= 2))];
  return { list: all.slice(0, MAX_CITIES), leftOut: all.slice(MAX_CITIES) };
}
