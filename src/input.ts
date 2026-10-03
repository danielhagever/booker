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

export function cityList(v: unknown): { list: string[]; leftOut: string[] } {
  const raw: unknown[] = typeof v === "string" ? v.split(/[;\n|]+/) : Array.isArray(v) ? v : [];
  const all = [...new Set(raw.map((c) => clean(c)).filter((c) => c.length >= 2))];
  return { list: all.slice(0, MAX_CITIES), leftOut: all.slice(MAX_CITIES) };
}
