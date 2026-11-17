import type { ThingView } from "./api.ts";

// Plain-text helpers shared by the TUI and the scriptable commands. Widths are terminal cells
// (an emoji or CJK character is two), measured by Bun.

export const width = (s: string) => Bun.stringWidth(s);

/** Cut to `w` cells, ending in "…" when something was cut. */
export function cut(s: string, w: number): string {
  if (w <= 0) return "";
  if (width(s) <= w) return s;
  let out = "";
  let n = 0;
  for (const ch of s) {
    const cw = width(ch);
    if (n + cw > w - 1) break;
    out += ch;
    n += cw;
  }
  return `${out}…`;
}

/** Exactly `w` cells: cut, then padded on the right (or the left with `right`). */
export function fit(s: string, w: number, right = false): string {
  const c = cut(s, w);
  const pad = " ".repeat(Math.max(0, w - width(c)));
  return right ? pad + c : c + pad;
}

export const SEP = " › ";

/**
 * A path in at most `w` cells, folded in the middle like the web app's rows:
 * "Bathroom › … › Box 42" keeps the room and the last step.
 */
export function foldPath(parts: string[], w: number): string {
  const full = parts.join(SEP);
  if (width(full) <= w || parts.length < 3) return cut(full, w);
  const first = parts[0]!;
  for (let keep = parts.length - 2; keep >= 1; keep--) {
    const s = [first, "…", ...parts.slice(parts.length - keep)].join(SEP);
    if (width(s) <= w) return s;
  }
  return cut([first, "…", parts.at(-1)!].join(SEP), w);
}

/** Has a place at all (physical): placed, roaming, or a "where" gap. Tags and papers don't. */
export const hasWhere = (t: ThingView) => t.path.length > 0 || t.roams || t.gaps.includes("where");

/** Where a thing is, in words: its path, or one of the two nowheres (D-026). */
export function whereParts(t: ThingView): string[] {
  if (t.path.length) return t.path.map((p) => p.name);
  return [t.roams ? "No fixed place" : "Not placed yet"];
}

export function whereText(t: ThingView, w = 999): string {
  const s = t.path.length
    ? foldPath(whereParts(t), w - (t.position ? width(t.position) + 3 : 0))
    : whereParts(t)[0]!;
  return t.position && t.path.length ? `${s} · ${t.position}` : s;
}

/** "now", "2m", "3h", "4d", "11-15" (older than a month). */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  if (s < 30 * 86_400) return `${Math.round(s / 86_400)}d`;
  return iso.slice(5, 10);
}

/** A field value as one line of text. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.map(valueText).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("amount" in o) return `${String(o.amount)} ${String(o.currency ?? "")}`.trim();
    return JSON.stringify(v);
  }
  return String(v).replace(/\s*\n\s*/g, " ⏎ ");
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
