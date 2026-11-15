import { createRequire } from "node:module";
import { BurrowError } from "@burrow/core";

// One open-source icon set bundled with the server (no network): Material Design Icons
// (Apache-2.0; ~7k icons, lots of household and electronics: drill, led-on, resistor, chip…), in
// Iconify JSON format. One set keeps search results free of near-identical duplicates. Search is by
// icon name and alias; it never sends item names anywhere.

interface IconSetJson {
  prefix: string;
  width?: number;
  height?: number;
  icons: Record<string, { body: string; width?: number; height?: number }>;
  aliases?: Record<string, { parent: string }>;
}
interface SetInfo {
  name: string;
  license: { title: string; spdx?: string; url?: string };
  author: { name: string; url?: string };
}

const require = createRequire(import.meta.url);
const SET = "mdi";

let loaded: { json: IconSetJson; info: SetInfo; names: [name: string, icon: string][] } | null = null;
function set() {
  if (!loaded) {
    const json = require(`@iconify-json/${SET}/icons.json`) as IconSetJson;
    const info = require(`@iconify-json/${SET}/info.json`) as SetInfo;
    // Search names: every icon plus its aliases, each pointing at the real icon.
    const names: [string, string][] = Object.keys(json.icons).map((n) => [n, n]);
    for (const [alias, { parent }] of Object.entries(json.aliases ?? {}))
      if (json.icons[parent]) names.push([alias, parent]);
    loaded = { json, info, names };
  }
  return loaded;
}

export interface IconHit {
  set: string;
  name: string;
}

export function searchIcons(q: string, limit = 60): IconHit[] {
  const words = q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
  if (!words.length) return [];
  const best = new Map<string, number>(); // real icon name → best score over its names
  for (const [name, icon] of set().names) {
    const parts = name.split("-");
    let score = 0;
    for (const w of words) {
      if (parts.includes(w)) score += 3;
      else if (parts.some((p) => p.startsWith(w) || (w.length > 3 && w.startsWith(p) && p.length > 3)))
        score += 1;
    }
    if (!score) continue;
    // Prefer plain over "-outline", "-off", "-plus"… variants, and short names over long ones.
    if (/-(outline|off|remove|minus|plus|check|alert|question|lock|cog|edit|\d+)$/.test(name)) score -= 0.5;
    score -= parts.length * 0.05;
    if (score > (best.get(icon) ?? -Infinity)) best.set(icon, score);
  }
  return [...best]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => ({ set: SET, name }));
}

/** A standalone SVG. currentColor becomes Burrow's ink colour so it shows in an <img>. */
export function iconSvg(setId: string, name: string): { svg: string; license: Record<string, unknown> } {
  if (setId !== SET) throw new BurrowError(`Unknown icon set "${setId}"`, 404);
  const s = set();
  const real = s.json.icons[name] ? name : s.json.aliases?.[name]?.parent;
  const icon = real ? s.json.icons[real] : undefined;
  if (!real || !icon) throw new BurrowError(`No icon ${setId}:${name}`, 404);
  const w = icon.width ?? s.json.width ?? 24;
  const h = icon.height ?? s.json.height ?? 24;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * 10}" height="${h * 10}" viewBox="0 0 ${w} ${h}" style="color:#1c1b19">${icon.body}</svg>`;
  return {
    svg,
    license: {
      set: setId,
      name: real,
      setName: s.info.name,
      license: s.info.license.spdx ?? s.info.license.title,
      licenseUrl: s.info.license.url,
      author: s.info.author.name,
    },
  };
}
