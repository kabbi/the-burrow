// One-off, idempotent migration to D-039: kinds are for fields and behaviour, categories are tags.
//   appliance   → device     (same fields: maker, model, serial, warranty)
//   electronics → component  (stock parts; pcb no longer extends it)
//   tool        → thing, tagged "tool"
// Archived things move too, so the old kinds end up unused and are removed (kind.removed).
// Every change is an event (undoable, survives a rebuild). Backs up with VACUUM INTO first.
//
//   pnpm --filter @burrow/server migrate:0006 [--dry-run] [--as device=B-0315,B-0316 ...]
// `--as kind=ids` puts those things in that kind instead of the default mapping.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Store, type FieldSource, type Kind } from "@burrow/core";
import { config } from "../config.ts";
import { aiMigrations } from "../ai/gateway.ts";

const ACTOR = "migration";
const DRY = process.argv.includes("--dry-run");
const MAP: Record<string, string> = { appliance: "device", electronics: "component", tool: "thing" };
const TAG: Record<string, string> = { tool: "tool" };

const overrides = new Map<string, string>();
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== "--as") continue;
  const [kind, ids] = (process.argv[++i] ?? "").split("=");
  if (!kind || !ids) throw new Error("--as needs kind=ID,ID");
  for (const id of ids.split(",")) overrides.set(id.trim(), kind.trim());
}

const store = Store.open(config.db, aiMigrations);
for (const k of new Set([...Object.values(MAP), ...overrides.values()]))
  if (!store.kind(k)) throw new Error(`No kind "${k}" (is the new seed deployed?)`);

if (!DRY) {
  const backups = join(dirname(config.db), "backups");
  mkdirSync(backups, { recursive: true });
  const backup = join(backups, `burrow-${new Date().toISOString().replace(/[:.]/g, "-")}-before-0006.sqlite`);
  store.db.exec(`vacuum into '${backup.replace(/'/g, "''")}'`);
  console.log("backup:", backup);
}

const report = {
  things: [] as string[],
  kinds: [] as string[],
  links: [] as string[],
  removed: [] as string[],
};

// --- 1. things (archived too)
const ids = new Set([
  ...(
    store.db
      .prepare(
        `select id from things where kind in (${Object.keys(MAP)
          .map(() => "?")
          .join(", ")})`,
      )
      .all(...Object.keys(MAP)) as { id: string }[]
  ).map((r) => r.id),
  ...overrides.keys(),
]);
for (const id of [...ids].sort()) {
  const t = store.getRaw(id);
  if (!t) throw new Error(`No thing ${id}`);
  const to = overrides.get(id) ?? MAP[t.kind] ?? t.kind;
  const tag = TAG[t.kind];
  report.things.push(`${id} ${t.name}: ${t.kind} → ${to}${tag ? ` +#${tag}` : ""}`);
  if (DRY) continue;
  // Keep who decided the kind: an AI guess stays unchecked.
  const source: FieldSource = t.meta.kind?.source ?? "you";
  if (tag) {
    const names = store.tagsOf(id).map((x) => x.name);
    if (!names.some((n) => n.toLowerCase() === tag)) store.setTags(id, [...names, tag], source, ACTOR);
  }
  if (to !== t.kind) store.change(id, { kind: to, sources: { kind: source } }, source, ACTOR);
}

// --- 2. kinds and link types that point at the old kinds
const own = ({ builtin: _, ...k }: Kind) => k;
for (const k of store.kinds())
  if (k.parent && MAP[k.parent]) {
    const parent = k.parent === "electronics" && k.id === "pcb" ? "thing" : (MAP[k.parent] ?? null);
    report.kinds.push(`${k.id}: extends ${k.parent} → ${parent}`);
    if (!DRY) store.defineKind({ ...own(k), parent }, ACTOR);
  }
for (const r of store.relationTypes()) {
  const swap = (ks: string[]) => [...new Set(ks.map((k) => MAP[k] ?? k))];
  if (![...r.fromKinds, ...r.toKinds].some((k) => MAP[k])) continue;
  report.links.push(r.id);
  const { builtin: _, ...rel } = r;
  if (!DRY) store.defineRelation({ ...rel, fromKinds: swap(r.fromKinds), toKinds: swap(r.toKinds) }, ACTOR);
}

// --- 3. the old kinds, now unused
for (const k of Object.keys(MAP))
  if (store.kind(k)) {
    report.removed.push(k);
    if (!DRY) store.removeKind(k, ACTOR);
  }

console.log(JSON.stringify({ dryRun: DRY, ...report }, null, 2));
