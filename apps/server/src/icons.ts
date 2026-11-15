import { createRequire } from "node:module";
import { BurrowError } from "@burrow/core";

// Open-source icon sets bundled with the server (no network): Tabler (MIT),
// Lucide (ISC) and Material Design Icons (Apache-2.0; filled, lots of
// electronics: led-on, resistor, chip, soldering-iron…), in Iconify JSON format. Search is by icon name; good enough for
// "drill", "plug", "box"… and it never sends item names anywhere.

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
const SETS = ["tabler", "lucide", "mdi"] as const;
export type IconSetId = (typeof SETS)[number];

const SET_TIEBREAK: Record<IconSetId, number> = { tabler: 0, lucide: 0.01, mdi: 0.02 };

let loaded: Map<string, { json: IconSetJson; info: SetInfo }> | null = null;
function sets() {
  loaded ??= new Map(
    SETS.map((id) => [
      id,
      {
        json: require(`@iconify-json/${id}/icons.json`) as IconSetJson,
        info: require(`@iconify-json/${id}/info.json`) as SetInfo,
      },
    ]),
  );
  return loaded;
}

export interface IconHit {
  set: IconSetId;
  name: string;
}

export function searchIcons(q: string, limit = 60): IconHit[] {
  const words = q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
  if (!words.length) return [];
  const scored: { hit: IconHit; score: number }[] = [];
  for (const [set, { json }] of sets()) {
    const names = [...Object.keys(json.icons), ...Object.keys(json.aliases ?? {})];
    for (const name of names) {
      const parts = name.split("-");
      let score = 0;
      for (const w of words) {
        if (parts.includes(w)) score += 3;
        else if (parts.some((p) => p.startsWith(w) || (w.length > 3 && w.startsWith(p) && p.length > 3)))
          score += 1;
      }
      if (!score) continue;
      // Prefer plain over "-filled", "-off", "-2" variants; on ties Tabler, then Lucide, then MDI
      // (line icons first, they match each other).
      if (/-(off|filled|x|minus|plus|check|exclamation|question|\d+)$/.test(name)) score -= 0.5;
      score -= parts.length * 0.05 + SET_TIEBREAK[set as IconSetId];
      scored.push({ hit: { set: set as IconSetId, name }, score });
    }
  }
  return scored
    .toSorted((a, b) => b.score - a.score || a.hit.name.localeCompare(b.hit.name))
    .slice(0, limit)
    .map((s) => s.hit);
}

/** A standalone SVG. currentColor becomes Burrow's ink colour so it shows in an <img>. */
export function iconSvg(set: string, name: string): { svg: string; license: Record<string, unknown> } {
  const s = sets().get(set);
  if (!s) throw new BurrowError(`Unknown icon set "${set}"`, 404);
  const real = s.json.icons[name] ? name : s.json.aliases?.[name]?.parent;
  const icon = real ? s.json.icons[real] : undefined;
  if (!icon) throw new BurrowError(`No icon ${set}:${name}`, 404);
  const w = icon.width ?? s.json.width ?? 24;
  const h = icon.height ?? s.json.height ?? 24;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * 10}" height="${h * 10}" viewBox="0 0 ${w} ${h}" style="color:#1c1b19">${icon.body}</svg>`;
  return {
    svg,
    license: {
      set,
      name,
      setName: s.info.name,
      license: s.info.license.spdx ?? s.info.license.title,
      licenseUrl: s.info.license.url,
      author: s.info.author.name,
    },
  };
}
