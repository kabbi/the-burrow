import { openDb, tx, type Db, type Migration } from "./db.ts";
import { formatId, parseId } from "./ids.ts";
import { builtinKinds, builtinRelations } from "./kinds.ts";
import { ASSET_ROLES } from "./types.ts";
import type {
  Asset,
  AssetPatch,
  AssetRef,
  AssetRole,
  BurrowEvent,
  Edge,
  EventBody,
  ExternalRef,
  FieldChange,
  FieldMeta,
  FieldSource,
  Kind,
  KindField,
  PathSegment,
  PlaceNode,
  RelationType,
  RelationView,
  TagRef,
  SearchHit,
  Thing,
  ThingId,
  ThingStatus,
  ThingView,
} from "./types.ts";

export class BurrowError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type Row = Record<string, unknown>;
const json = (v: unknown) => JSON.stringify(v ?? {});
const parse = <T>(v: unknown, fallback: T): T => (typeof v === "string" ? (JSON.parse(v) as T) : fallback);

export interface CreateThingInput {
  name: string;
  kind?: string;
  data?: Record<string, unknown>;
  parentId?: ThingId | null;
  /** Provenance for every provided field; per-field overrides in `sources`. */
  source?: FieldSource;
  sources?: Record<string, FieldSource>;
}

export interface ChangeInput {
  name?: string;
  kind?: string;
  /** null or undefined values remove the key. */
  data?: Record<string, unknown>;
  /** Per-field provenance ("name", "kind" or a data key), overriding the call's `source`. */
  sources?: Record<string, FieldSource>;
}

export interface StoreOptions {
  now?: () => string;
}

/** Event types the UI may offer "Undo" for. */
export const UNDOABLE = new Set([
  "thing.created",
  "thing.changed",
  "thing.moved",
  "thing.status",
  "thing.confirmed",
  "thing.archived",
  "ref.linked",
  "ref.unlinked",
  "edge.added",
  "edge.removed",
  "asset.added",
  "asset.changed",
  "asset.removed",
  "asset.cover",
]);

export interface AddAssetInput {
  role: AssetRole;
  file: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  thumb?: string;
  original?: string;
  key?: string;
  label?: string;
  source?: FieldSource;
  data?: Record<string, unknown>;
}

const ASSET_PATCH_KEYS = [
  "role",
  "label",
  "thumb",
  "file",
  "mime",
  "bytes",
  "width",
  "height",
  "original",
  "key",
  "data",
] as const;
const FILE_RE = /^[\w.-]+$/;

/** Cover fallback order when nobody picked one. Models only count once they have a poster. */
const COVER_ORDER: AssetRole[] = ["photo", "product", "sprite", "icon", "other", "model"];

/**
 * The Burrow core: an append-only event log plus projections (things, edges,
 * refs, search index). All writes go through `append`, which validates the
 * event against the current state and applies it in one transaction.
 */
export class Store {
  private now: () => string;
  readonly db: Db;

  constructor(db: Db, opts: StoreOptions = {}) {
    this.db = db;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.seedKinds();
  }

  static open(path: string, extra: Migration[] = [], opts?: StoreOptions): Store {
    return new Store(openDb(path, extra), opts);
  }

  // ------------------------------------------------------------ write side

  append(body: EventBody, actor = "you", undoOf: number | null = null): BurrowEvent {
    return tx(this.db, () => {
      this.validate(body);
      const at = this.now();
      // Links are filed under their "from" thing so they show up in its history.
      const thingId =
        "id" in body ? body.id : "thingId" in body ? body.thingId : "fromId" in body ? body.fromId : null;
      const res = this.db
        .prepare("insert into events (at, actor, type, thing_id, body, undo_of) values (?, ?, ?, ?, ?, ?)")
        .run(at, actor, body.type, thingId, JSON.stringify(body), undoOf);
      const event: BurrowEvent = { seq: Number(res.lastInsertRowid), at, actor, body, undoOf };
      this.apply(event);
      return event;
    });
  }

  createThing(input: CreateThingInput, actor = "you"): ThingView {
    const name = input.name.trim();
    if (!name) throw new BurrowError("A thing needs a name");
    const kind = input.kind ?? "thing";
    const at = this.now();
    const data = clean(input.data ?? {});
    const meta: Record<string, FieldMeta> = {};
    const src = (k: string) => input.sources?.[k] ?? input.source ?? "you";
    for (const k of ["name", "kind", ...Object.keys(data)]) meta[k] = { source: src(k), at };
    if (input.parentId) meta.parent = { source: src("parent"), at };
    const seq = this.nextSeq();
    const id = formatId(seq);
    this.append(
      { type: "thing.created", id, seq, kind, name, data, meta, parentId: input.parentId ?? null },
      actor,
    );
    return this.mustGet(id);
  }

  change(id: ThingId, patch: ChangeInput, source: FieldSource = "you", actor = "you"): ThingView {
    const t = this.mustGetRaw(id);
    const changes: FieldChange[] = [];
    const add = (field: string, from: unknown, to: unknown) => {
      if (same(from, to)) return;
      const src = patch.sources?.[field.replace(/^data\./, "")] ?? source;
      changes.push({ field, from, to, source: src, fromMeta: t.meta[metaKey(field)] ?? null });
    };
    if (patch.name !== undefined) add("name", t.name, patch.name.trim());
    if (patch.kind !== undefined) add("kind", t.kind, patch.kind);
    for (const [k, v] of Object.entries(patch.data ?? {})) {
      add(`data.${k}`, t.data[k] ?? null, isEmpty(v) ? null : v);
    }
    if (changes.length) this.append({ type: "thing.changed", id, changes }, actor);
    return this.mustGet(id);
  }

  /**
   * Put a thing inside another (or nowhere). `position` is the spot inside it ("shelf 3"):
   * undefined keeps the current spot when staying put and clears it when moving elsewhere.
   */
  move(
    id: ThingId,
    to: ThingId | null,
    actor = "you",
    source?: FieldSource,
    position?: string | null,
  ): ThingView {
    const t = this.mustGetRaw(id);
    const pos = position === undefined ? (t.parentId === to ? t.position : null) : position?.trim() || null;
    const spot = to ? pos : null;
    if (t.parentId !== to || t.position !== spot)
      this.append(
        {
          type: "thing.moved",
          id,
          from: t.parentId,
          to,
          ...(source ? { source } : {}),
          ...(spot ? { position: spot } : {}),
          ...(t.position ? { fromPosition: t.position } : {}),
        },
        actor,
      );
    return this.mustGet(id);
  }

  setStatus(id: ThingId, to: ThingStatus, note?: string, actor = "you"): ThingView {
    const t = this.mustGetRaw(id);
    if (t.status !== to)
      this.append({ type: "thing.status", id, from: t.status, to, ...(note ? { note } : {}) }, actor);
    return this.mustGet(id);
  }

  /** Mark guessed fields as checked by a person (they stop being violet). */
  confirm(id: ThingId, fields: string[], actor = "you"): ThingView {
    this.append({ type: "thing.confirmed", id, fields }, actor);
    return this.mustGet(id);
  }

  archive(id: ThingId, actor = "you"): ThingView {
    this.append({ type: "thing.archived", id }, actor);
    return this.mustGet(id);
  }

  link(
    thingId: ThingId,
    service: string,
    remoteId: string,
    data: Record<string, unknown> = {},
    actor = "you",
  ): void {
    this.append({ type: "ref.linked", thingId, service, remoteId, data }, actor);
  }

  unlink(thingId: ThingId, service: string, remoteId: string, actor = "you"): void {
    this.append({ type: "ref.unlinked", thingId, service, remoteId }, actor);
  }

  /** Link two things with a relation type. A "one" relation replaces the previous link. */
  relate(
    type: string,
    fromId: ThingId,
    toId: ThingId,
    data: Record<string, unknown> = {},
    actor = "you",
  ): void {
    tx(this.db, () => {
      const rt = this.relationType(type);
      if (rt?.cardinality === "one") {
        for (const e of this.edges({ type, fromId }))
          if (e.toId !== toId)
            this.append({ type: "edge.removed", edgeType: type, fromId, toId: e.toId }, actor);
      }
      if (rt?.symmetric && this.edges({ type, fromId: toId, toId: fromId }).length) return;
      this.append({ type: "edge.added", edgeType: type, fromId, toId, data }, actor);
    });
  }

  unrelate(type: string, fromId: ThingId, toId: ThingId, actor = "you"): void {
    const rt = this.relationType(type);
    // Symmetric links are stored once, in whichever direction they were made.
    if (
      rt?.symmetric &&
      !this.edges({ type, fromId, toId }).length &&
      this.edges({ type, fromId: toId, toId: fromId }).length
    )
      this.append({ type: "edge.removed", edgeType: type, fromId: toId, toId: fromId }, actor);
    else this.append({ type: "edge.removed", edgeType: type, fromId, toId }, actor);
  }

  defineKind(kind: Omit<Kind, "builtin">, actor = "you"): void {
    this.append({ type: "kind.defined", kind }, actor);
  }

  defineRelation(relation: Omit<RelationType, "builtin">, actor = "you"): void {
    this.append({ type: "relation.defined", relation }, actor);
  }

  /** Find a tag by name or alias (case-insensitive), or create it. */
  ensureTag(
    name: string,
    actor = "you",
    parentId: ThingId | null = null,
    source: FieldSource = actor === "you" ? "you" : "ai",
  ): ThingId {
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean) throw new BurrowError("A tag needs a name");
    const found = this.findTag(clean);
    if (found) return found;
    return this.createThing({ name: clean, kind: "tag", parentId, source }, actor).id;
  }

  findTag(name: string): ThingId | null {
    const n = name.trim().toLowerCase();
    const rows = this.db
      .prepare(
        `select id, name, data from things where archived_at is null and kind in (${this.kindAndDescendantsSql("tag")})`,
      )
      .all() as { id: string; name: string; data: string }[];
    const hit =
      rows.find((r) => r.name.toLowerCase() === n) ??
      rows.find((r) =>
        ((parse(r.data, {}) as { aliases?: string[] }).aliases ?? []).some((a) => a.toLowerCase() === n),
      );
    return hit?.id ?? null;
  }

  /** Make a thing's tags exactly `names` (created if new). Returns the thing. */
  setTags(id: ThingId, names: string[], source: FieldSource = "you", actor = "you"): ThingView {
    return tx(this.db, () => {
      const t = this.mustGetRaw(id);
      const want = new Set(names.filter((n) => n.trim()).map((n) => this.ensureTag(n, actor, null, source)));
      const have = this.edges({ type: "tagged", fromId: t.id });
      for (const e of have) if (!want.has(e.toId)) this.unrelate("tagged", t.id, e.toId, actor);
      for (const tagId of want)
        if (!have.some((e) => e.toId === tagId)) this.relate("tagged", t.id, tagId, { source }, actor);
      return this.mustGet(t.id);
    });
  }

  /**
   * Toggle an event: undo it, or, if it is already undone, undo the undo
   * (i.e. redo). Always appends; history is never rewritten.
   */
  toggleUndo(seq: number, actor = "you"): BurrowEvent {
    return tx(this.db, () => {
      const e = this.event(seq);
      if (!e) throw new BurrowError(`No event #${seq}`, 404);
      if (!UNDOABLE.has(e.body.type)) throw new BurrowError(`${e.body.type} can't be undone`);
      const active = this.activeUndoOf(seq);
      if (active) return this.toggleUndo(active.seq, actor);
      return this.append(this.inverse(e.body), actor, seq);
    });
  }

  // ------------------------------------------------------------ assets (D-015)

  addAsset(thingId: ThingId, input: AddAssetInput, actor = "you"): Asset {
    this.mustGetRaw(thingId);
    const r = this.db.prepare("select value from kv where key = 'next_asset'").get() as Row | undefined;
    const id = `A-${String(r ? Number(r.value) : 1).padStart(4, "0")}`;
    const asset = {
      id,
      thingId,
      role: input.role,
      file: input.file,
      mime: input.mime,
      bytes: input.bytes,
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      ...(input.thumb ? { thumb: input.thumb } : {}),
      ...(input.original ? { original: input.original } : {}),
      ...(input.key ? { key: input.key } : {}),
      ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      source: input.source ?? "you",
      data: input.data ?? {},
    };
    this.append({ type: "asset.added", thingId, asset }, actor);
    return this.mustGetAsset(id);
  }

  changeAsset(assetId: string, patch: AssetPatch, actor = "you"): Asset {
    const a = this.mustGetAsset(assetId);
    const from: AssetPatch = {};
    const to: AssetPatch = {};
    for (const k of ASSET_PATCH_KEYS) {
      if (!(k in patch)) continue;
      const v = patch[k];
      const next = v === "" ? null : (v ?? null);
      const prev = a[k] ?? null;
      if (same(prev, next)) continue;
      (from as Record<string, unknown>)[k] = prev;
      (to as Record<string, unknown>)[k] = next;
    }
    if (Object.keys(to).length)
      this.append({ type: "asset.changed", thingId: a.thingId, assetId, from, to }, actor);
    return this.mustGetAsset(assetId);
  }

  /** Soft removal (undoable). The file stays on disk. */
  removeAsset(assetId: string, actor = "you"): void {
    const a = this.mustGetAsset(assetId);
    if (a.removedAt) return;
    this.append({ type: "asset.removed", thingId: a.thingId, assetId }, actor);
  }

  /** Pick the asset the UI shows for a thing; null goes back to automatic. */
  setCover(thingId: ThingId, assetId: string | null, actor = "you"): ThingView {
    const t = this.mustGetRaw(thingId);
    const from = this.coverId(t.id);
    if (from !== assetId) this.append({ type: "asset.cover", thingId: t.id, from, to: assetId }, actor);
    return this.mustGet(t.id);
  }

  asset(id: string): Asset | null {
    const r = this.db.prepare("select * from assets where id = ?").get(id) as Row | undefined;
    return r ? toAsset(r) : null;
  }

  mustGetAsset(id: string): Asset {
    const a = this.asset(id);
    if (!a) throw new BurrowError(`No asset ${id}`, 404);
    return a;
  }

  /** The asset a system filed under `key` for this thing (removed ones included). */
  assetByKey(thingId: ThingId, key: string): Asset | null {
    const r = this.db.prepare("select * from assets where thing_id = ? and key = ?").get(thingId, key) as
      | Row
      | undefined;
    return r ? toAsset(r) : null;
  }

  /** A thing's assets, oldest first. Removed ones only with `removed`. */
  assets(thingId: ThingId, opts: { removed?: boolean; role?: AssetRole } = {}): Asset[] {
    const where = ["thing_id = ?"];
    const args: string[] = [thingId];
    if (!opts.removed) where.push("removed_at is null");
    if (opts.role) {
      where.push("role = ?");
      args.push(opts.role);
    }
    return (
      this.db.prepare(`select * from assets where ${where.join(" and ")} order by seq`).all(...args) as Row[]
    ).map(toAsset);
  }

  /** The explicitly chosen cover, if any (and still there). */
  coverId(thingId: ThingId): string | null {
    const r = this.db
      .prepare(
        `select a.id from things t join assets a on a.id = t.cover_id and a.removed_at is null where t.id = ?`,
      )
      .get(thingId) as Row | undefined;
    return r ? String(r.id) : null;
  }

  /** What the UI shows: the chosen cover, else the first asset by COVER_ORDER that can be drawn. */
  cover(thingId: ThingId): AssetRef | null {
    const pick = this.coverAsset(thingId);
    return pick ? assetRef(pick) : null;
  }

  /** The asset behind `cover()`. */
  coverAsset(thingId: ThingId): Asset | null {
    const all = this.assets(thingId).filter((a) => assetRef(a).imageUrl);
    const chosen = this.coverId(thingId);
    return (
      all.find((a) => a.id === chosen) ??
      all.toSorted((a, b) => COVER_ORDER.indexOf(a.role) - COVER_ORDER.indexOf(b.role))[0] ??
      null
    );
  }

  // ------------------------------------------------------------ read side

  get(id: ThingId): ThingView | null {
    const t = this.getRaw(id);
    return t ? this.view(t) : null;
  }

  mustGet(id: ThingId): ThingView {
    const t = this.get(id);
    if (!t) throw new BurrowError(`No thing ${id}`, 404);
    return t;
  }

  getRaw(id: ThingId): Thing | null {
    const seq = parseId(id);
    const row = (
      seq !== null
        ? this.db.prepare("select * from things where seq = ?").get(seq)
        : this.db.prepare("select * from things where id = ?").get(id)
    ) as Row | undefined;
    return row ? toThing(row) : null;
  }

  list(
    opts: {
      kind?: string;
      parentId?: ThingId | null;
      places?: boolean;
      /** Only physical, non-place things (no tags, documents, rooms). */
      physical?: boolean;
      archived?: boolean;
      limit?: number;
      offset?: number;
      order?: "recent" | "name";
    } = {},
  ): ThingView[] {
    const where: string[] = [];
    const args: (string | number | null)[] = [];
    if (!opts.archived) where.push("archived_at is null");
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    if (opts.parentId !== undefined) {
      if (opts.parentId === null) where.push("parent_id is null");
      else {
        where.push("parent_id = ?");
        args.push(opts.parentId);
      }
    }
    if (opts.physical) where.push("kind in (select id from kinds where physical = 1 and is_place = 0)");
    if (opts.places !== undefined)
      where.push(`kind ${opts.places ? "" : "not "}in (select id from kinds where is_place = 1)`);
    const order = opts.order === "name" ? "name collate nocase" : "seq desc";
    const sql = `select * from things ${where.length ? "where " + where.join(" and ") : ""}
      order by ${order} limit ? offset ?`;
    args.push(opts.limit ?? 100, opts.offset ?? 0);
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => this.view(toThing(r)));
  }

  /** Every place with its full path, for pickers. Sorted by path. */
  places(): { id: ThingId; name: string; kind: string; path: string; depth: number }[] {
    const rows = this.db
      .prepare(
        `select t.id, t.name, t.kind from things t join kinds k on k.id = t.kind
         where k.is_place = 1 and t.archived_at is null`,
      )
      .all() as { id: string; name: string; kind: string }[];
    return rows
      .map((r) => {
        const path = this.path(r.id);
        return {
          ...r,
          path: [...path.map((p) => p.name), r.name].join(" › "),
          depth: path.length,
        };
      })
      .toSorted((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Every place with item counts (direct and nested), for the Places tree.
   * Sorted by spot then name, numbers in order ("shelf 2" before "shelf 10").
   */
  placeTree(): { places: PlaceNode[]; unplaced: number } {
    const kinds = new Map(this.kinds().map((k) => [k.id, k]));
    const rows = this.db
      .prepare("select id, name, kind, parent_id, position, status from things where archived_at is null")
      .all() as {
      id: string;
      name: string;
      kind: string;
      parent_id: string | null;
      position: string | null;
      status: ThingStatus;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const nodes = new Map<string, PlaceNode>();
    for (const r of rows)
      if (kinds.get(r.kind)?.isPlace)
        nodes.set(r.id, {
          id: r.id,
          name: r.name,
          kind: r.kind,
          parentId: r.parent_id,
          position: r.position,
          cover: this.cover(r.id),
          items: 0,
          total: 0,
          status: r.status,
        });
    let unplaced = 0;
    for (const r of rows) {
      const k = kinds.get(r.kind);
      if (!k || k.isPlace || !k.physical) continue;
      if (!r.parent_id) {
        unplaced++;
        continue;
      }
      const direct = nodes.get(r.parent_id);
      if (direct) direct.items++;
      for (let p: string | null = r.parent_id, n = 0; p && n < 64; p = byId.get(p)?.parent_id ?? null, n++) {
        const node = nodes.get(p);
        if (node) node.total++;
      }
    }
    const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const places = [...nodes.values()].toSorted(
      (a, b) => cmp.compare(a.position ?? "", b.position ?? "") || cmp.compare(a.name, b.name),
    );
    return { places, unplaced };
  }

  /** Spots already used inside a place, for suggestions ("shelf 1", "shelf 2"…). */
  positionsIn(parentId: ThingId): string[] {
    return (
      this.db
        .prepare(
          "select distinct position from things where parent_id = ? and position is not null and archived_at is null",
        )
        .all(parentId) as { position: string }[]
    )
      .map((r) => r.position)
      .toSorted(new Intl.Collator(undefined, { numeric: true }).compare);
  }

  path(id: ThingId): PathSegment[] {
    const rows = this.db
      .prepare(
        `with recursive up(id, parent_id, name, kind, position, depth) as (
           select id, parent_id, name, kind, position, 0 from things where id = ?
           union all
           select t.id, t.parent_id, t.name, t.kind, t.position, up.depth + 1
           from things t join up on t.id = up.parent_id where up.depth < 64
         ) select id, name, kind, position from up where depth > 0 order by depth desc`,
      )
      .all(id) as unknown as PathSegment[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      ...(r.position ? { position: r.position } : {}),
    }));
  }

  /** Prefix search; `any` = match any word (for fuzzy "related" guesses). */
  search(q: string, limit = 20, opts: { any?: boolean } = {}): SearchHit[] {
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    const direct = parseId(q);
    if (direct !== null) {
      const t = this.get(formatId(direct));
      if (t && !t.archivedAt) {
        hits.push({ thing: t, score: 1000 });
        seen.add(t.id);
      }
    }
    const match = ftsQuery(q, opts.any);
    if (!match) return hits;
    const rows = this.db
      .prepare(
        `select f.id, bm25(things_fts, 0, 10, 2, 1) as rank from things_fts f
         join things t on t.id = f.id
         where things_fts match ? and t.archived_at is null
         order by rank limit ?`,
      )
      .all(match, limit) as { id: string; rank: number }[];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      const t = this.get(r.id);
      if (t) hits.push({ thing: t, score: -r.rank });
    }
    return hits;
  }

  kinds(): Kind[] {
    return (this.db.prepare("select * from kinds order by builtin desc, name").all() as Row[]).map(toKind);
  }

  kind(id: string): Kind | null {
    const r = this.db.prepare("select * from kinds where id = ?").get(id) as Row | undefined;
    return r ? toKind(r) : null;
  }

  /** The kind and its ancestors, nearest first. */
  kindChain(id: string): Kind[] {
    const out: Kind[] = [];
    for (let k = this.kind(id); k && out.length < 16; k = k.parent ? this.kind(k.parent) : null) {
      if (out.some((x) => x.id === k!.id)) break;
      out.push(k);
    }
    return out;
  }

  /** True if `kind` is `ancestor` or extends it. */
  kindIs(kind: string, ancestor: string): boolean {
    return this.kindChain(kind).some((k) => k.id === ancestor);
  }

  /** Effective fields: inherited first, a child's field overrides a parent's with the same key. */
  fieldsOf(kindId: string): KindField[] {
    const byKey = new Map<string, KindField>();
    for (const k of this.kindChain(kindId).toReversed()) for (const f of k.fields) byKey.set(f.key, f);
    return [...byKey.values()];
  }

  private kindAndDescendantsSql(id: string): string {
    const ids = this.kinds()
      .filter((k) => this.kindIs(k.id, id))
      .map((k) => `'${k.id.replace(/'/g, "''")}'`);
    return ids.length ? ids.join(",") : "''";
  }

  relationTypes(): RelationType[] {
    return (this.db.prepare("select * from relation_types order by builtin desc, name").all() as Row[]).map(
      toRelation,
    );
  }

  relationType(id: string): RelationType | null {
    const r = this.db.prepare("select * from relation_types where id = ?").get(id) as Row | undefined;
    return r ? toRelation(r) : null;
  }

  /** All typed links of a thing, both directions, labelled from its side. */
  relations(id: ThingId): RelationView[] {
    const rows = this.db
      .prepare(
        `select e.*, 'out' dir, t.id oid, t.name oname, t.kind okind from edges e join things t on t.id = e.to_id where e.from_id = ?
         union all
         select e.*, 'in' dir, t.id oid, t.name oname, t.kind okind from edges e join things t on t.id = e.from_id where e.to_id = ?
         order by 1`,
      )
      .all(id, id) as Row[];
    return rows.map((r) => {
      const rt = this.relationType(String(r.type));
      const dir = r.dir as "out" | "in";
      return {
        edgeId: Number(r.id),
        type: String(r.type),
        direction: dir,
        label: rt ? (dir === "out" || rt.symmetric ? rt.name : rt.inverse) : String(r.type),
        other: { id: String(r.oid), name: String(r.oname), kind: String(r.okind) },
        data: parse(r.data, {}),
      };
    });
  }

  tagsOf(id: ThingId): TagRef[] {
    const rows = this.db
      .prepare(
        `select t.id, t.name, e.data from edges e join things t on t.id = e.to_id
         where e.type = 'tagged' and e.from_id = ? and t.archived_at is null order by t.name collate nocase`,
      )
      .all(id) as { id: string; name: string; data: string }[];
    return rows.map((r) => {
      const src = (parse(r.data, {}) as { source?: FieldSource }).source;
      return {
        id: r.id,
        name: r.name,
        path: this.path(r.id).map((p) => p.name),
        ...(src ? { source: src } : {}),
      };
    });
  }

  /** Things tagged with `tagId` or any tag nested under it. */
  taggedWith(tagId: ThingId, limit = 500): ThingView[] {
    const rows = this.db
      .prepare(
        `with recursive sub(id) as (select ? union all select t.id from things t join sub on t.parent_id = sub.id)
         select distinct th.* from edges e join things th on th.id = e.from_id
         where e.type = 'tagged' and e.to_id in (select id from sub) and th.archived_at is null
         order by th.name collate nocase limit ?`,
      )
      .all(tagId, limit) as Row[];
    return rows.map((r) => this.view(toThing(r)));
  }

  refsOf(thingId: ThingId): ExternalRef[] {
    return (this.db.prepare("select * from external_refs where thing_id = ?").all(thingId) as Row[]).map(
      toRef,
    );
  }

  findRef(service: string, remoteId: string): ExternalRef | null {
    const r = this.db
      .prepare("select * from external_refs where service = ? and remote_id = ?")
      .get(service, remoteId) as Row | undefined;
    return r ? toRef(r) : null;
  }

  refsByService(service: string): ExternalRef[] {
    return (this.db.prepare("select * from external_refs where service = ?").all(service) as Row[]).map(
      toRef,
    );
  }

  edges(opts: { type?: string; fromId?: string; toId?: string }): Edge[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.type) {
      where.push("type = ?");
      args.push(opts.type);
    }
    if (opts.fromId) {
      where.push("from_id = ?");
      args.push(opts.fromId);
    }
    if (opts.toId) {
      where.push("to_id = ?");
      args.push(opts.toId);
    }
    return (
      this.db
        .prepare(`select * from edges ${where.length ? "where " + where.join(" and ") : ""} order by id`)
        .all(...args) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      type: String(r.type),
      fromId: String(r.from_id),
      toId: String(r.to_id),
      data: parse(r.data, {}),
      createdAt: String(r.created_at),
    }));
  }

  event(seq: number): BurrowEvent | null {
    const r = this.db.prepare("select * from events where seq = ?").get(seq) as Row | undefined;
    return r ? toEvent(r) : null;
  }

  events(
    opts: {
      thingId?: ThingId;
      types?: string[];
      limit?: number;
      includeUndos?: boolean;
      /** Only events after this seq, oldest first (a sync cursor). */
      after?: number;
      actor?: string;
    } = {},
  ): BurrowEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.after !== undefined) {
      where.push("seq > ?");
      args.push(opts.after);
    }
    if (opts.actor) {
      where.push("actor = ?");
      args.push(opts.actor);
    }
    if (opts.thingId) {
      where.push("thing_id = ?");
      args.push(opts.thingId);
    }
    if (opts.types?.length) {
      where.push(`type in (${opts.types.map(() => "?").join(",")})`);
      args.push(...opts.types);
    }
    if (!opts.includeUndos) where.push("undo_of is null");
    args.push(opts.limit ?? 50);
    const rows = this.db
      .prepare(
        `select * from events ${where.length ? "where " + where.join(" and ") : ""}
         order by seq ${opts.after !== undefined ? "asc" : "desc"} limit ?`,
      )
      .all(...args) as Row[];
    const undone = this.undoneSet();
    return rows.map((r) => ({ ...toEvent(r), undone: undone.has(Number(r.seq)) }));
  }

  /** Things missing details worth having. Places and Common-tier things are skipped. */
  needsDetails(limit = 200): ThingView[] {
    const out: ThingView[] = [];
    const rows = this.db
      .prepare(
        `select t.* from things t join kinds k on k.id = t.kind
         where t.archived_at is null and k.is_place = 0 and k.physical = 1 order by t.seq desc`,
      )
      .all() as Row[];
    for (const r of rows) {
      const v = this.view(toThing(r));
      if (v.gaps.length) out.push(v);
      if (out.length >= limit) break;
    }
    return out;
  }

  stats() {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as Row).n);
    return {
      things: one(
        "select count(*) n from things where archived_at is null and kind in (select id from kinds where is_place = 0 and physical = 1)",
      ),
      places: one(
        "select count(*) n from things where archived_at is null and kind in (select id from kinds where is_place = 1)",
      ),
      missing: one("select count(*) n from things where archived_at is null and status = 'missing'"),
      tags: one(
        `select count(*) n from things where archived_at is null and kind in (${this.kindAndDescendantsSql("tag")})`,
      ),
      documents: one(
        `select count(*) n from things where archived_at is null and kind in (${this.kindAndDescendantsSql("document")})`,
      ),
      events: one("select count(*) n from events"),
    };
  }

  /** Drop all projections and replay the log. Used by tests and `pnpm rebuild`. */
  rebuild(): void {
    tx(this.db, () => {
      this.db.exec(
        "delete from things_fts; delete from assets; delete from external_refs; delete from edges; delete from things; delete from kinds where builtin = 0; delete from relation_types where builtin = 0; delete from kv where key in ('next_seq', 'next_asset');",
      );
      this.db.exec("pragma defer_foreign_keys = on");
      const rows = this.db.prepare("select * from events order by seq").all() as Row[];
      for (const r of rows) this.apply(toEvent(r));
    });
  }

  // ------------------------------------------------------------ internals

  private seedKinds() {
    const ins = this.db.prepare(
      `insert into kinds (id, name, parent, is_place, physical, fields, builtin) values (?, ?, ?, ?, ?, ?, 1)
       on conflict(id) do update set name = excluded.name, parent = excluded.parent, is_place = excluded.is_place,
         physical = excluded.physical, fields = excluded.fields where kinds.builtin = 1`,
    );
    for (const k of builtinKinds)
      ins.run(k.id, k.name, k.parent, k.isPlace ? 1 : 0, k.physical ? 1 : 0, JSON.stringify(k.fields));
    const rel = this.db.prepare(
      `insert into relation_types (id, name, inverse, from_kinds, to_kinds, cardinality, symmetric, builtin)
       values (?, ?, ?, ?, ?, ?, ?, 1)
       on conflict(id) do update set name = excluded.name, inverse = excluded.inverse, from_kinds = excluded.from_kinds,
         to_kinds = excluded.to_kinds, cardinality = excluded.cardinality, symmetric = excluded.symmetric
       where relation_types.builtin = 1`,
    );
    for (const r of builtinRelations)
      rel.run(
        r.id,
        r.name,
        r.inverse,
        JSON.stringify(r.fromKinds),
        JSON.stringify(r.toKinds),
        r.cardinality,
        r.symmetric ? 1 : 0,
      );
  }

  private nextSeq(): number {
    const r = this.db.prepare("select value from kv where key = 'next_seq'").get() as Row | undefined;
    return r ? Number(r.value) : 1;
  }

  private mustGetRaw(id: ThingId): Thing {
    const t = this.getRaw(id);
    if (!t) throw new BurrowError(`No thing ${id}`, 404);
    return t;
  }

  private view(t: Thing): ThingView {
    const childCount = Number(
      (
        this.db
          .prepare("select count(*) n from things where parent_id = ? and archived_at is null")
          .get(t.id) as Row
      ).n,
    );
    return {
      ...t,
      path: this.path(t.id),
      refs: this.refsOf(t.id),
      gaps: this.gaps(t),
      childCount,
      tags: this.tagsOf(t.id),
      cover: this.cover(t.id),
    };
  }

  private gaps(t: Thing): string[] {
    const kind = this.kind(t.kind);
    if (!kind || kind.isPlace || t.archivedAt || t.data.tier === 0) return [];
    const gaps: string[] = [];
    if (kind.physical && !t.parentId) gaps.push("where");
    for (const f of this.fieldsOf(kind.id)) if (f.wanted && isEmpty(t.data[f.key])) gaps.push(f.key);
    return gaps;
  }

  /** A value for a field the kind declares must match its type. Undeclared fields are free-form. */
  private checkField(kind: string, key: string, v: unknown) {
    const f = this.fieldsOf(kind).find((x) => x.key === key);
    if (!f || v === null || v === undefined) return;
    const bad = (why: string): never => {
      throw new BurrowError(`${f.label}: ${why}`);
    };
    switch (f.type) {
      case "number":
      case "money":
        if (typeof v !== "number" || !Number.isFinite(v)) bad("must be a number");
        break;
      case "boolean":
        if (typeof v !== "boolean") bad("must be yes or no");
        break;
      case "date":
        if (typeof v !== "string" || !/^\d{4}-\d{2}(-\d{2})?/.test(v)) bad("must be a date like 2026-11-14");
        break;
      case "select":
        if (typeof v !== "string" || (f.options?.length && !f.options.includes(v)))
          bad(`must be one of ${f.options?.join(", ")}`);
        break;
      case "list":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) bad("must be a list of text");
        break;
      case "ref": {
        const t = typeof v === "string" ? this.getRaw(v) : null;
        if (!t) bad("must point to an existing thing");
        else if (f.refKind && !this.kindIs(t.kind, f.refKind)) bad(`must point to a ${f.refKind}`);
        break;
      }
      default:
        if (typeof v !== "string") bad("must be text");
    }
  }

  private validate(b: EventBody) {
    const needThing = (id: string) => {
      if (!this.getRaw(id)) throw new BurrowError(`No thing ${id}`, 404);
    };
    switch (b.type) {
      case "thing.created":
        if (this.getRaw(b.id)) throw new BurrowError(`${b.id} already exists`, 409);
        if (!this.kind(b.kind)) throw new BurrowError(`Unknown kind "${b.kind}"`);
        if (b.parentId) needThing(b.parentId);
        for (const [k, v] of Object.entries(b.data)) this.checkField(b.kind, k, v);
        break;
      case "thing.changed":
        needThing(b.id);
        for (const c of b.changes) {
          if (c.field.startsWith("data.") && c.to !== null && c.to !== undefined) {
            const kindChange = b.changes.find((x) => x.field === "kind");
            this.checkField(String(kindChange?.to ?? this.getRaw(b.id)!.kind), c.field.slice(5), c.to);
          }
          if (c.field === "kind" && !this.kind(String(c.to)))
            throw new BurrowError(`Unknown kind "${String(c.to)}"`);
          if (c.field === "name" && !String(c.to ?? "").trim()) throw new BurrowError("A thing needs a name");
        }
        break;
      case "thing.moved":
        needThing(b.id);
        if (b.position && b.position.length > 80)
          throw new BurrowError("Keep the spot short (80 characters)");
        if (b.to) {
          needThing(b.to);
          // "inside" rules: exactly one parent (a column), and no loops.
          if (b.to === b.id || this.path(b.to).some((p) => p.id === b.id))
            throw new BurrowError("Can't put a thing inside itself");
        }
        break;
      case "thing.status":
      case "thing.confirmed":
      case "thing.archived":
        needThing(b.id);
        break;
      case "ref.linked":
        needThing(b.thingId);
        break;
      case "edge.added": {
        const rt = this.relationType(b.edgeType);
        if (!rt) throw new BurrowError(`Unknown relation "${b.edgeType}"`);
        const from = this.getRaw(b.fromId);
        const to = this.getRaw(b.toId);
        if (!from) throw new BurrowError(`No thing ${b.fromId}`, 404);
        if (!to) throw new BurrowError(`No thing ${b.toId}`, 404);
        if (from.id === to.id) throw new BurrowError("A thing can't be linked to itself");
        const fits = (kind: string, allowed: string[]) =>
          !allowed.length || allowed.some((a) => this.kindIs(kind, a));
        if (!fits(from.kind, rt.fromKinds) || !fits(to.kind, rt.toKinds))
          throw new BurrowError(`“${rt.name}” can't link a ${from.kind} to a ${to.kind}`);
        if (
          rt.cardinality === "one" &&
          this.edges({ type: rt.id, fromId: from.id }).some((e) => e.toId !== to.id)
        )
          throw new BurrowError(`${from.name} already ${rt.name} something`);
        break;
      }
      case "asset.added":
        needThing(b.thingId);
        if (!ASSET_ROLES.includes(b.asset.role))
          throw new BurrowError(`Unknown asset role "${b.asset.role}"`);
        if (this.asset(b.asset.id)) throw new BurrowError(`${b.asset.id} already exists`, 409);
        for (const f of [b.asset.file, b.asset.thumb, b.asset.original])
          if (f !== undefined && !FILE_RE.test(f)) throw new BurrowError("Bad asset file name");
        if (b.asset.key && this.assetByKey(b.thingId, b.asset.key))
          throw new BurrowError(`${b.thingId} already has an asset with key ${b.asset.key}`, 409);
        break;
      case "asset.changed":
      case "asset.removed": {
        const a = this.mustGetAsset(b.assetId);
        if (a.thingId !== b.thingId) throw new BurrowError(`${b.assetId} belongs to ${a.thingId}`);
        if (b.type === "asset.changed") {
          if (b.to.role && !ASSET_ROLES.includes(b.to.role))
            throw new BurrowError(`Unknown asset role "${b.to.role}"`);
          for (const f of [b.to.thumb, b.to.file, b.to.original])
            if (f && !FILE_RE.test(f)) throw new BurrowError("Bad asset file name");
          if (b.to.file === null) throw new BurrowError("An asset needs a file");
          if (b.to.key) {
            const other = this.assetByKey(b.thingId, b.to.key);
            if (other && other.id !== b.assetId)
              throw new BurrowError(`${b.thingId} already has an asset with key ${b.to.key}`, 409);
          }
        }
        break;
      }
      case "asset.cover":
        needThing(b.thingId);
        if (b.to) {
          const a = this.mustGetAsset(b.to);
          if (a.thingId !== b.thingId) throw new BurrowError(`${b.to} belongs to ${a.thingId}`);
          if (a.removedAt) throw new BurrowError(`${b.to} was removed`);
        }
        break;
      case "kind.defined": {
        const k = b.kind;
        if (!/^[a-z][a-z0-9_-]{0,40}$/.test(k.id)) throw new BurrowError(`Bad kind id "${k.id}"`);
        if (k.parent) {
          if (!this.kind(k.parent)) throw new BurrowError(`Unknown parent kind "${k.parent}"`);
          if (k.parent === k.id || this.kindIs(k.parent, k.id))
            throw new BurrowError("Kinds can't extend themselves");
        }
        const keys = k.fields.map((f) => f.key);
        if (new Set(keys).size !== keys.length) throw new BurrowError("Field keys must be unique");
        break;
      }
      case "relation.defined": {
        const r = b.relation;
        if (!/^[a-z][a-z0-9_]{0,40}$/.test(r.id)) throw new BurrowError(`Bad relation id "${r.id}"`);
        for (const k of [...r.fromKinds, ...r.toKinds])
          if (!this.kind(k)) throw new BurrowError(`Unknown kind "${k}"`);
        break;
      }
    }
  }

  private apply(e: BurrowEvent) {
    const b = e.body;
    const at = e.at;
    const touch = (id: string) =>
      this.db.prepare("update things set updated_at = ? where id = ?").run(at, id);
    switch (b.type) {
      case "thing.created": {
        this.db
          .prepare(
            `insert into things (id, seq, kind, name, data, meta, parent_id, status, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`,
          )
          .run(b.id, b.seq, b.kind, b.name, json(b.data), json(b.meta), b.parentId, at, at);
        this.db
          .prepare(
            `insert into kv (key, value) values ('next_seq', ?)
             on conflict(key) do update set value = max(cast(value as integer), excluded.value)`,
          )
          .run(String(b.seq + 1));
        this.reindex(b.id);
        break;
      }
      case "thing.changed": {
        const t = this.mustGetRaw(b.id);
        let reindexTree = false;
        for (const c of b.changes) {
          const mk = metaKey(c.field);
          const removing = c.to === null || c.to === undefined;
          if (c.field === "name") {
            t.name = String(c.to);
            reindexTree = true;
          } else if (c.field === "kind") t.kind = String(c.to);
          else if (c.field.startsWith("data.")) {
            const k = c.field.slice(5);
            if (removing) delete t.data[k];
            else t.data[k] = c.to;
          }
          const m = c.toMeta !== undefined ? c.toMeta : removing ? null : { source: c.source ?? "you", at };
          if (m) t.meta[mk] = m;
          else delete t.meta[mk];
        }
        this.db
          .prepare("update things set name = ?, kind = ?, data = ?, meta = ?, updated_at = ? where id = ?")
          .run(t.name, t.kind, json(t.data), json(t.meta), at, b.id);
        if (reindexTree) this.reindexTree(b.id);
        else this.reindex(b.id);
        break;
      }
      case "thing.moved": {
        const t = this.mustGetRaw(b.id);
        if (b.to) t.meta.parent = { source: b.source ?? (e.actor === "you" ? "you" : "import"), at };
        else delete t.meta.parent;
        this.db
          .prepare("update things set parent_id = ?, position = ?, meta = ?, updated_at = ? where id = ?")
          .run(b.to, b.to ? (b.position ?? null) : null, json(t.meta), at, b.id);
        this.reindexTree(b.id);
        break;
      }
      case "thing.status":
        this.db.prepare("update things set status = ?, updated_at = ? where id = ?").run(b.to, at, b.id);
        break;
      case "thing.confirmed": {
        const t = this.mustGetRaw(b.id);
        for (const f of b.fields) {
          const m = t.meta[f];
          if (!m) continue;
          if (b.undo) delete m.confirmed;
          else m.confirmed = true;
        }
        this.db.prepare("update things set meta = ? where id = ?").run(json(t.meta), b.id);
        touch(b.id);
        break;
      }
      case "thing.archived":
        this.db
          .prepare("update things set archived_at = ?, updated_at = ? where id = ?")
          .run(b.undo ? null : at, at, b.id);
        break;
      case "ref.linked":
        this.db
          .prepare(
            `insert into external_refs (thing_id, service, remote_id, data, synced_at) values (?, ?, ?, ?, ?)
             on conflict(service, remote_id) do update set thing_id = excluded.thing_id,
               data = excluded.data, synced_at = excluded.synced_at`,
          )
          .run(b.thingId, b.service, b.remoteId, json(b.data), at);
        this.reindex(b.thingId);
        break;
      case "ref.unlinked":
        this.db
          .prepare("delete from external_refs where service = ? and remote_id = ?")
          .run(b.service, b.remoteId);
        this.reindex(b.thingId);
        break;
      case "edge.added":
        this.db
          .prepare(
            `insert into edges (type, from_id, to_id, data, created_at) values (?, ?, ?, ?, ?)
             on conflict(type, from_id, to_id) do update set data = excluded.data`,
          )
          .run(b.edgeType, b.fromId, b.toId, json(b.data), at);
        this.reindex(b.fromId);
        break;
      case "edge.removed":
        this.db
          .prepare("delete from edges where type = ? and from_id = ? and to_id = ?")
          .run(b.edgeType, b.fromId, b.toId);
        this.reindex(b.fromId);
        break;
      case "asset.added": {
        const a = b.asset;
        const seq = Number(a.id.replace(/^A-0*/, ""));
        this.db
          .prepare(
            `insert into assets (id, seq, thing_id, role, file, mime, bytes, width, height, thumb, original, key,
               label, source, data, added_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            a.id,
            seq,
            b.thingId,
            a.role,
            a.file,
            a.mime,
            a.bytes,
            a.width ?? null,
            a.height ?? null,
            a.thumb ?? null,
            a.original ?? null,
            a.key ?? null,
            a.label ?? null,
            a.source,
            json(a.data),
            at,
          );
        this.db
          .prepare(
            `insert into kv (key, value) values ('next_asset', ?)
             on conflict(key) do update set value = max(cast(value as integer), excluded.value)`,
          )
          .run(String(seq + 1));
        touch(b.thingId);
        break;
      }
      case "asset.changed":
        for (const [k, v] of Object.entries(b.to)) {
          if (!(ASSET_PATCH_KEYS as readonly string[]).includes(k)) continue;
          const val = k === "data" ? json(v) : ((v as string | number | null) ?? null);
          this.db.prepare(`update assets set ${k} = ? where id = ?`).run(val, b.assetId);
        }
        touch(b.thingId);
        break;
      case "asset.removed":
        this.db.prepare("update assets set removed_at = ? where id = ?").run(b.undo ? null : at, b.assetId);
        touch(b.thingId);
        break;
      case "asset.cover":
        this.db
          .prepare("update things set cover_id = ?, updated_at = ? where id = ?")
          .run(b.to, at, b.thingId);
        break;
      case "kind.defined":
        // A definition with a builtin id overrides the seed (and stays user-owned).
        this.db
          .prepare(
            `insert into kinds (id, name, parent, is_place, physical, fields, builtin) values (?, ?, ?, ?, ?, ?, 0)
             on conflict(id) do update set name = excluded.name, parent = excluded.parent, is_place = excluded.is_place,
               physical = excluded.physical, fields = excluded.fields, builtin = 0`,
          )
          .run(
            b.kind.id,
            b.kind.name,
            b.kind.parent ?? null,
            b.kind.isPlace ? 1 : 0,
            b.kind.physical === false ? 0 : 1,
            JSON.stringify(b.kind.fields),
          );
        break;
      case "relation.defined": {
        const r = b.relation;
        this.db
          .prepare(
            `insert into relation_types (id, name, inverse, from_kinds, to_kinds, cardinality, symmetric, builtin)
             values (?, ?, ?, ?, ?, ?, ?, 0)
             on conflict(id) do update set name = excluded.name, inverse = excluded.inverse, from_kinds = excluded.from_kinds,
               to_kinds = excluded.to_kinds, cardinality = excluded.cardinality, symmetric = excluded.symmetric, builtin = 0`,
          )
          .run(
            r.id,
            r.name,
            r.inverse,
            JSON.stringify(r.fromKinds),
            JSON.stringify(r.toKinds),
            r.cardinality,
            r.symmetric ? 1 : 0,
          );
        break;
      }
    }
  }

  /** The event that reverses `b`, computed against the current state. */
  private inverse(b: EventBody): EventBody {
    switch (b.type) {
      case "thing.created":
        return { type: "thing.archived", id: b.id };
      case "thing.changed": {
        const t = this.mustGetRaw(b.id);
        return {
          type: "thing.changed",
          id: b.id,
          changes: b.changes.map((c) => {
            const mk = metaKey(c.field);
            return {
              field: c.field,
              from: currentValue(t, c.field),
              to: c.from,
              fromMeta: t.meta[mk] ?? null,
              toMeta: c.fromMeta ?? null,
            };
          }),
        };
      }
      case "thing.moved": {
        const t = this.mustGetRaw(b.id);
        return {
          type: "thing.moved",
          id: b.id,
          from: t.parentId,
          to: b.from,
          ...(b.fromPosition ? { position: b.fromPosition } : {}),
          ...(t.position ? { fromPosition: t.position } : {}),
        };
      }
      case "thing.status":
        return { type: "thing.status", id: b.id, from: this.mustGetRaw(b.id).status, to: b.from };
      case "thing.confirmed":
        return { type: "thing.confirmed", id: b.id, fields: b.fields, undo: !b.undo };
      case "thing.archived":
        return { type: "thing.archived", id: b.id, undo: !b.undo };
      case "ref.linked":
        return { type: "ref.unlinked", thingId: b.thingId, service: b.service, remoteId: b.remoteId };
      case "ref.unlinked": {
        const prev = this.db
          .prepare(
            `select body from events where type = 'ref.linked' and json_extract(body, '$.service') = ?
             and json_extract(body, '$.remoteId') = ? order by seq desc limit 1`,
          )
          .get(b.service, b.remoteId) as Row | undefined;
        const data = prev ? ((parse(prev.body, {}) as { data?: Record<string, unknown> }).data ?? {}) : {};
        return { type: "ref.linked", thingId: b.thingId, service: b.service, remoteId: b.remoteId, data };
      }
      case "edge.added":
        return { type: "edge.removed", edgeType: b.edgeType, fromId: b.fromId, toId: b.toId };
      case "edge.removed": {
        const prev = this.db
          .prepare(
            `select body from events where type = 'edge.added' and json_extract(body, '$.edgeType') = ?
             and json_extract(body, '$.fromId') = ? and json_extract(body, '$.toId') = ? order by seq desc limit 1`,
          )
          .get(b.edgeType, b.fromId, b.toId) as Row | undefined;
        const data = prev ? ((parse(prev.body, {}) as { data?: Record<string, unknown> }).data ?? {}) : {};
        return { type: "edge.added", edgeType: b.edgeType, fromId: b.fromId, toId: b.toId, data };
      }
      case "asset.added":
        return { type: "asset.removed", thingId: b.thingId, assetId: b.asset.id };
      case "asset.removed":
        return { type: "asset.removed", thingId: b.thingId, assetId: b.assetId, undo: !b.undo };
      case "asset.changed": {
        const a = this.mustGetAsset(b.assetId);
        const from = Object.fromEntries(
          Object.keys(b.to).map((k) => [k, (a as unknown as Record<string, unknown>)[k] ?? null]),
        ) as AssetPatch;
        return { type: "asset.changed", thingId: b.thingId, assetId: b.assetId, from, to: b.from };
      }
      case "asset.cover":
        return {
          type: "asset.cover",
          thingId: b.thingId,
          from: (this.db.prepare("select cover_id from things where id = ?").get(b.thingId) as Row)
            .cover_id as string | null,
          to: b.from,
        };
      default:
        throw new BurrowError(`${b.type} can't be undone`);
    }
  }

  private activeUndoOf(seq: number): BurrowEvent | null {
    const rows = this.db
      .prepare("select * from events where undo_of = ? order by seq desc")
      .all(seq) as Row[];
    const undone = this.undoneSet();
    const r = rows.find((x) => !undone.has(Number(x.seq)));
    return r ? toEvent(r) : null;
  }

  /** seqs of events whose effect is currently reversed. */
  private undoneSet(): Set<number> {
    const rows = this.db
      .prepare("select seq, undo_of from events where undo_of is not null order by seq desc")
      .all() as { seq: number; undo_of: number }[];
    // Walk newest first: an undo is active unless a later undo reversed it.
    const undone = new Set<number>();
    for (const r of rows) {
      if (!undone.has(Number(r.seq))) undone.add(Number(r.undo_of));
    }
    return undone;
  }

  private reindex(id: ThingId) {
    const t = this.getRaw(id);
    this.db.prepare("delete from things_fts where id = ?").run(id);
    if (!t) return;
    // Every text-ish field is searchable, custom ones included; tags with their parents.
    const values = Object.entries(t.data)
      .filter(([k]) => !NOT_SEARCHED.has(k))
      .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
      .filter((v) => typeof v === "string" || typeof v === "number");
    const refs = this.refsOf(id).map((r) => `${r.service} ${String(r.data.assetId ?? "")}`);
    const tags = this.tagsOf(id).flatMap((tg) => [tg.name, ...tg.path]);
    const body = [id, ...values, ...tags, ...refs]
      .filter((x) => x !== undefined && x !== null && x !== "")
      .join(" \n ");
    const path = [...this.path(id).flatMap((p) => [p.name, p.position ?? ""]), t.position ?? ""]
      .filter(Boolean)
      .join(" ");
    this.db
      .prepare("insert into things_fts (id, name, body, path) values (?, ?, ?, ?)")
      .run(id, t.name, body, path);
  }

  /** Reindex a thing, everything inside it, and everything tagged with it (or a tag under it). */
  private reindexTree(id: ThingId) {
    const rows = this.db
      .prepare(
        `with recursive down(id) as (select ? union all select t.id from things t join down on t.parent_id = down.id)
         select id from down
         union
         select e.from_id from edges e where e.type = 'tagged' and e.to_id in (
           with recursive d2(id) as (select ? union all select t.id from things t join d2 on t.parent_id = d2.id) select id from d2)`,
      )
      .all(id, id) as { id: string }[];
    for (const r of rows) this.reindex(r.id);
  }
}

// ---------------------------------------------------------------- helpers

function metaKey(field: string) {
  return field.startsWith("data.") ? field.slice(5) : field;
}

function currentValue(t: Thing, field: string): unknown {
  if (field === "name") return t.name;
  if (field === "kind") return t.kind;
  return t.data[field.slice(5)] ?? null;
}

function isEmpty(v: unknown) {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

function clean(data: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => !isEmpty(v)));
}

function same(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Turn free text into an FTS5 query: every word must match as a prefix. */
export function ftsQuery(q: string, any = false): string | null {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 12);
  if (!words.length) return null;
  return words.map((w) => `"${w}"*`).join(any ? " OR " : " ");
}

function toAsset(r: Row): Asset {
  return {
    id: String(r.id),
    thingId: String(r.thing_id),
    role: r.role as AssetRole,
    file: String(r.file),
    mime: String(r.mime),
    bytes: Number(r.bytes),
    ...(r.width != null ? { width: Number(r.width) } : {}),
    ...(r.height != null ? { height: Number(r.height) } : {}),
    ...(r.thumb != null ? { thumb: String(r.thumb) } : {}),
    ...(r.original != null ? { original: String(r.original) } : {}),
    ...(r.key != null ? { key: String(r.key) } : {}),
    ...(r.label != null ? { label: String(r.label) } : {}),
    source: r.source as FieldSource,
    data: parse(r.data, {}),
    addedAt: String(r.added_at),
    removedAt: (r.removed_at as string | null) ?? null,
  };
}

/** How to draw an asset. Images draw themselves; models and other files need a thumb (poster). */
export function assetRef(a: Asset): AssetRef {
  const fileUrl = `/media/${a.file}`;
  const thumbUrl = a.thumb ? `/media/${a.thumb}` : null;
  const imageUrl = a.mime.startsWith("image/") ? fileUrl : thumbUrl;
  return {
    id: a.id,
    role: a.role,
    mime: a.mime,
    fileUrl,
    imageUrl,
    thumbUrl: thumbUrl ?? imageUrl,
    originalUrl: a.original ? `/media/${a.original}` : null,
  };
}

function toThing(r: Row): Thing {
  return {
    id: String(r.id),
    seq: Number(r.seq),
    kind: String(r.kind),
    name: String(r.name),
    data: parse(r.data, {}),
    meta: parse(r.meta, {}),
    parentId: (r.parent_id as string | null) ?? null,
    position: (r.position as string | null) ?? null,
    status: r.status as ThingStatus,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    archivedAt: (r.archived_at as string | null) ?? null,
  };
}

const NOT_SEARCHED = new Set(["imageUrl", "thumbUrl", "url"]);

function toRelation(r: Row): RelationType {
  return {
    id: String(r.id),
    name: String(r.name),
    inverse: String(r.inverse),
    fromKinds: parse(r.from_kinds, []),
    toKinds: parse(r.to_kinds, []),
    cardinality: r.cardinality === "one" ? "one" : "many",
    symmetric: Number(r.symmetric) === 1,
    builtin: Number(r.builtin) === 1,
  };
}

function toKind(r: Row): Kind {
  return {
    id: String(r.id),
    name: String(r.name),
    parent: (r.parent as string | null) ?? null,
    physical: Number(r.physical ?? 1) === 1,
    isPlace: Number(r.is_place) === 1,
    fields: parse(r.fields, []),
    builtin: Number(r.builtin) === 1,
  };
}

function toRef(r: Row): ExternalRef {
  return {
    thingId: String(r.thing_id),
    service: String(r.service),
    remoteId: String(r.remote_id),
    data: parse(r.data, {}),
    syncedAt: String(r.synced_at),
  };
}

function toEvent(r: Row): BurrowEvent {
  return {
    seq: Number(r.seq),
    at: String(r.at),
    actor: String(r.actor),
    body: parse(r.body, {} as EventBody),
    undoOf: r.undo_of === null ? null : Number(r.undo_of),
  };
}
