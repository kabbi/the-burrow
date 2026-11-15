import type { Store, ThingView } from "@burrow/core";
import type { LookPairs, VisualMatcher } from "./vision.ts";

// Things you may have twice (D-034): the same name, or pictures that look the same, or pictures
// alike *and* similar names. DINOv2 scores every PCB on white at ~0.9 (D-019), so looks alone
// only count when they are very close; names alone only when nothing contradicts them.

/** Looks this close are the same object (or the same photo) on their own. */
const LOOKS_SAME = 0.95;
/** Looks this close count with a similar name. */
const LOOKS_ALIKE = 0.88;
/** Both have pictures but they look less alike than this: a shared name is a coincidence. */
const LOOKS_DIFFERENT = 0.8;
/** Share of name words in common (Jaccard) that counts with alike looks / on its own. */
const NAME_WITH_LOOKS = 0.35;
const NAME_ALONE = 0.6;
const MAX_PAIRS = 100;

/** Words that say nothing about which thing it is. */
const FILLER = new Set(
  "a an and the of for with in on to by module board breakout clone style kit set pcs pack new old".split(
    " ",
  ),
);

export interface DuplicatePair {
  a: ThingView;
  b: ThingView;
  /** Why they're offered: "name" = same name, "looks" = look the same, "both" = alike and similar names. */
  why: "name" | "looks" | "both";
  /** Picture similarity, 0..1 (absent: one of them has no indexed picture). */
  looks?: number;
  /** Share of name words in common, 0..1. */
  words: number;
}

interface Row {
  id: string;
  name: string;
  parentId: string | null;
  isPlace: number;
}

export function findDuplicates(store: Store, vision: VisualMatcher, limit = MAX_PAIRS): DuplicatePair[] {
  // Physical things only: tags, papers and people have their own pages (and tags merge there).
  const rows = store.db
    .prepare(
      `select t.id, t.name, t.parent_id parentId, k.is_place isPlace from things t join kinds k on k.id = t.kind
       where t.archived_at is null and k.physical = 1`,
    )
    .all() as unknown as Row[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Any link between two things means you already know they're different ("not the same as",
  // accessory of, replaces…).
  const linked = new Set(
    (
      store.db.prepare("select from_id f, to_id t from edges where type != 'tagged'").all() as {
        f: string;
        t: string;
      }[]
    ).map((e) => pairKey(e.f, e.t)),
  );
  const looks: LookPairs = vision.pairs?.(LOOKS_ALIKE) ?? { scores: new Map(), pictured: new Set() };

  const tokens = new Map(rows.map((r) => [r.id, words(r.name)]));
  const norm = new Map(
    rows.map((r) => [
      r.id,
      r.name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim(),
    ]),
  );
  const found = new Map<string, Omit<DuplicatePair, "a" | "b"> & { ids: [string, string] }>();

  const consider = (x: Row, y: Row) => {
    const key = pairKey(x.id, y.id);
    if (found.has(key) || linked.has(key)) return;
    // Places pair only with places in the same place ("Drawer 1" is fine in two cabinets).
    if (x.isPlace !== y.isPlace || (x.isPlace && x.parentId !== y.parentId)) return;
    const l = looks.scores.get(key);
    const bothPictured = looks.pictured.has(x.id) && looks.pictured.has(y.id);
    const w = jaccard(tokens.get(x.id)!, tokens.get(y.id)!);
    const same = norm.get(x.id) !== "" && norm.get(x.id) === norm.get(y.id);
    // Both name a model and no model matches (ESP32S3 / RP2040, A4988 / DRV8825): related, not the same.
    const mx = models(tokens.get(x.id)!);
    const my = models(tokens.get(y.id)!);
    const otherModel = mx.length > 0 && my.length > 0 && !mx.some((m) => my.includes(m));
    let why: DuplicatePair["why"] | null = null;
    if (same && !(bothPictured && (l ?? 0) < LOOKS_DIFFERENT)) why = "name";
    else if (l !== undefined && l >= LOOKS_SAME) why = "looks";
    else if (otherModel) why = null;
    else if (l !== undefined && l >= LOOKS_ALIKE && w >= NAME_WITH_LOOKS) why = "both";
    else if (!bothPictured && w >= NAME_ALONE) why = "both";
    if (!why) return;
    const [a, b] = x.id < y.id ? [x.id, y.id] : [y.id, x.id];
    found.set(key, { ids: [a, b], why, words: w, ...(l !== undefined ? { looks: l } : {}) });
  };

  // Look-alike pairs, then pairs that share a distinctive word (no all-pairs over names).
  for (const key of looks.scores.keys()) {
    const [a, b] = key.split("|") as [string, string];
    const x = byId.get(a);
    const y = byId.get(b);
    if (x && y) consider(x, y);
  }
  const byWord = new Map<string, Row[]>();
  for (const r of rows) for (const t of tokens.get(r.id)!) byWord.set(t, [...(byWord.get(t) ?? []), r]);
  for (const group of byWord.values()) {
    // A word half the house shares ("usb", "cable") is no lead.
    if (group.length > 40) continue;
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) consider(group[i]!, group[j]!);
  }
  // Same name, even made only of common or filler words ("USB cable", "Box").
  const byName = new Map<string, Row[]>();
  for (const r of rows) byName.set(norm.get(r.id)!, [...(byName.get(norm.get(r.id)!) ?? []), r]);
  for (const group of byName.values())
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) consider(group[i]!, group[j]!);

  return [...found.values()]
    .toSorted((p, q) => rank(q) - rank(p))
    .slice(0, limit)
    .map(({ ids, ...p }) => ({ a: store.get(ids[0])!, b: store.get(ids[1])!, ...p }))
    .filter((p) => p.a && p.b);
}

function rank(p: { why: string; looks?: number; words: number }) {
  return (p.why === "name" ? 2 : 0) + Math.max(p.looks ?? 0, p.words);
}

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function words(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 2 && !FILLER.has(w)),
  );
}

/** Words that look like a model or part number (hx711, 6050, nrf52840), not a size (5v, 24ghz). */
function models(ws: Set<string>): string[] {
  return [...ws].filter((w) => w.length >= 3 && /\d/.test(w) && !UNIT.test(w));
}
const UNIT = /^\d+(?:[.,]\d+)?(?:v|a|ma|w|mah|mm|cm|m|g|kg|hz|khz|mhz|ghz|kb|mb|gb|tb|pcs|x)$/;

function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}
