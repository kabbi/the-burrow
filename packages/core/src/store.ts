import { openDb, tx, type Db, type Migration } from "./db.ts";
import { formatId, parseId } from "./ids.ts";
import { builtinKinds } from "./kinds.ts";
import type {
  BurrowEvent,
  Edge,
  EventBody,
  ExternalRef,
  FieldChange,
  FieldMeta,
  FieldSource,
  Kind,
  PathSegment,
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
]);

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
      const thingId = "id" in body ? body.id : "thingId" in body ? body.thingId : null;
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
      changes.push({ field, from, to, source, fromMeta: t.meta[metaKey(field)] ?? null });
    };
    if (patch.name !== undefined) add("name", t.name, patch.name.trim());
    if (patch.kind !== undefined) add("kind", t.kind, patch.kind);
    for (const [k, v] of Object.entries(patch.data ?? {})) {
      add(`data.${k}`, t.data[k] ?? null, isEmpty(v) ? null : v);
    }
    if (changes.length) this.append({ type: "thing.changed", id, changes }, actor);
    return this.mustGet(id);
  }

  move(id: ThingId, to: ThingId | null, actor = "you", source?: FieldSource): ThingView {
    const t = this.mustGetRaw(id);
    if (t.parentId !== to)
      this.append({ type: "thing.moved", id, from: t.parentId, to, ...(source ? { source } : {}) }, actor);
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

  addEdge(edgeType: string, fromId: string, toId: string, data: Record<string, unknown> = {}, actor = "you") {
    this.append({ type: "edge.added", edgeType, fromId, toId, data }, actor);
  }

  removeEdge(edgeType: string, fromId: string, toId: string, actor = "you") {
    this.append({ type: "edge.removed", edgeType, fromId, toId }, actor);
  }

  defineKind(kind: Omit<Kind, "builtin">, actor = "you"): void {
    this.append({ type: "kind.defined", kind }, actor);
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

  path(id: ThingId): PathSegment[] {
    const rows = this.db
      .prepare(
        `with recursive up(id, parent_id, name, kind, depth) as (
           select id, parent_id, name, kind, 0 from things where id = ?
           union all
           select t.id, t.parent_id, t.name, t.kind, up.depth + 1
           from things t join up on t.id = up.parent_id where up.depth < 64
         ) select id, name, kind from up where depth > 0 order by depth desc`,
      )
      .all(id) as unknown as PathSegment[];
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind }));
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
    opts: { thingId?: ThingId; types?: string[]; limit?: number; includeUndos?: boolean } = {},
  ): BurrowEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
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
        `select * from events ${where.length ? "where " + where.join(" and ") : ""} order by seq desc limit ?`,
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
         where t.archived_at is null and k.is_place = 0 order by t.seq desc`,
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
        "select count(*) n from things where archived_at is null and kind not in (select id from kinds where is_place = 1)",
      ),
      places: one(
        "select count(*) n from things where archived_at is null and kind in (select id from kinds where is_place = 1)",
      ),
      missing: one("select count(*) n from things where archived_at is null and status = 'missing'"),
      events: one("select count(*) n from events"),
    };
  }

  /** Drop all projections and replay the log. Used by tests and `pnpm rebuild`. */
  rebuild(): void {
    tx(this.db, () => {
      this.db.exec(
        "delete from things_fts; delete from external_refs; delete from edges; delete from things; delete from kinds where builtin = 0; delete from kv where key = 'next_seq';",
      );
      this.db.exec("pragma defer_foreign_keys = on");
      const rows = this.db.prepare("select * from events order by seq").all() as Row[];
      for (const r of rows) this.apply(toEvent(r));
    });
  }

  // ------------------------------------------------------------ internals

  private seedKinds() {
    const ins = this.db.prepare(
      `insert into kinds (id, name, is_place, fields, builtin) values (?, ?, ?, ?, 1)
       on conflict(id) do update set name = excluded.name, is_place = excluded.is_place,
         fields = excluded.fields where kinds.builtin = 1`,
    );
    for (const k of builtinKinds) ins.run(k.id, k.name, k.isPlace ? 1 : 0, JSON.stringify(k.fields));
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
    return { ...t, path: this.path(t.id), refs: this.refsOf(t.id), gaps: this.gaps(t), childCount };
  }

  private gaps(t: Thing): string[] {
    const kind = this.kind(t.kind);
    if (!kind || kind.isPlace || t.archivedAt || t.data.tier === 0) return [];
    const gaps: string[] = [];
    if (!t.parentId) gaps.push("where");
    for (const f of kind.fields) if (f.wanted && isEmpty(t.data[f.key])) gaps.push(f.key);
    return gaps;
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
        break;
      case "thing.changed":
        needThing(b.id);
        for (const c of b.changes) {
          if (c.field === "kind" && !this.kind(String(c.to)))
            throw new BurrowError(`Unknown kind "${String(c.to)}"`);
          if (c.field === "name" && !String(c.to ?? "").trim()) throw new BurrowError("A thing needs a name");
        }
        break;
      case "thing.moved":
        needThing(b.id);
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
          .prepare("update things set parent_id = ?, meta = ?, updated_at = ? where id = ?")
          .run(b.to, json(t.meta), at, b.id);
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
        break;
      case "edge.removed":
        this.db
          .prepare("delete from edges where type = ? and from_id = ? and to_id = ?")
          .run(b.edgeType, b.fromId, b.toId);
        break;
      case "kind.defined":
        this.db
          .prepare(
            `insert into kinds (id, name, is_place, fields, builtin) values (?, ?, ?, ?, 0)
             on conflict(id) do update set name = excluded.name, is_place = excluded.is_place, fields = excluded.fields`,
          )
          .run(b.kind.id, b.kind.name, b.kind.isPlace ? 1 : 0, JSON.stringify(b.kind.fields));
        break;
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
      case "thing.moved":
        return { type: "thing.moved", id: b.id, from: this.mustGetRaw(b.id).parentId, to: b.from };
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
      case "edge.removed":
        return { type: "edge.added", edgeType: b.edgeType, fromId: b.fromId, toId: b.toId, data: {} };
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
    const d = t.data;
    const refs = this.refsOf(id).map((r) => `${r.service} ${String(r.data.assetId ?? "")}`);
    const body = [
      id,
      d.description,
      Array.isArray(d.tags) ? d.tags.join(" ") : d.tags,
      d.maker,
      d.model,
      d.serial,
      d.notes,
      ...refs,
    ]
      .filter((x) => x !== undefined && x !== null && x !== "")
      .join(" \n ");
    const path = this.path(id)
      .map((p) => p.name)
      .join(" ");
    this.db
      .prepare("insert into things_fts (id, name, body, path) values (?, ?, ?, ?)")
      .run(id, t.name, body, path);
  }

  private reindexTree(id: ThingId) {
    const rows = this.db
      .prepare(
        `with recursive down(id) as (select ? union all select t.id from things t join down on t.parent_id = down.id)
         select id from down`,
      )
      .all(id) as { id: string }[];
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

function toThing(r: Row): Thing {
  return {
    id: String(r.id),
    seq: Number(r.seq),
    kind: String(r.kind),
    name: String(r.name),
    data: parse(r.data, {}),
    meta: parse(r.meta, {}),
    parentId: (r.parent_id as string | null) ?? null,
    status: r.status as ThingStatus,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    archivedAt: (r.archived_at as string | null) ?? null,
  };
}

function toKind(r: Row): Kind {
  return {
    id: String(r.id),
    name: String(r.name),
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
