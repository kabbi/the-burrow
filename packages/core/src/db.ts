import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

export interface Migration {
  /** Unique, stable id: "<module>/<nnn>-<name>". Never rename an applied one. */
  id: string;
  sql: string;
}

/**
 * Core schema. The `events` table is the source of truth; every other core
 * table is a projection that `Store.rebuild()` can recreate from the log.
 */
export const coreMigrations: Migration[] = [
  {
    id: "core/001-init",
    sql: `
      create table events (
        seq integer primary key,
        at text not null,
        actor text not null,
        type text not null,
        thing_id text,
        body text not null,
        undo_of integer references events(seq)
      );
      create index events_thing on events(thing_id, seq);
      create index events_undo on events(undo_of);

      create table kinds (
        id text primary key,
        name text not null,
        is_place integer not null default 0,
        fields text not null default '[]',
        builtin integer not null default 0
      );

      create table things (
        id text primary key,
        seq integer not null unique,
        kind text not null,
        name text not null,
        data text not null default '{}',
        meta text not null default '{}',
        parent_id text references things(id),
        status text not null default 'ok',
        created_at text not null,
        updated_at text not null,
        archived_at text
      );
      create index things_parent on things(parent_id);
      create index things_kind on things(kind);

      create table edges (
        id integer primary key,
        type text not null,
        from_id text not null,
        to_id text not null,
        data text not null default '{}',
        created_at text not null,
        unique(type, from_id, to_id)
      );
      create index edges_to on edges(to_id, type);

      create table external_refs (
        thing_id text not null references things(id),
        service text not null,
        remote_id text not null,
        data text not null default '{}',
        synced_at text not null,
        primary key (service, remote_id)
      );
      create index external_refs_thing on external_refs(thing_id);

      create virtual table things_fts using fts5(
        id unindexed, name, body, path,
        tokenize = "unicode61 remove_diacritics 2"
      );

      create table kv (key text primary key, value text not null);
    `,
  },
  {
    id: "core/002-schema-as-data",
    sql: `
      alter table kinds add column parent text;
      alter table kinds add column physical integer not null default 1;
      create table relation_types (
        id text primary key,
        name text not null,
        inverse text not null,
        from_kinds text not null default '[]',
        to_kinds text not null default '[]',
        cardinality text not null default 'many',
        symmetric integer not null default 0,
        builtin integer not null default 0
      );
      create index edges_from on edges(from_id, type);
    `,
  },
  {
    id: "core/003-edge-events-thing-id",
    sql: `
      update events set thing_id = json_extract(body, '$.fromId')
      where type in ('edge.added', 'edge.removed') and thing_id is null;
    `,
  },
];

export function openDb(path: string, extra: Migration[] = []): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  migrate(db, [...coreMigrations, ...extra]);
  return db;
}

export function migrate(db: Db, migrations: Migration[]): void {
  db.exec("create table if not exists migrations (id text primary key, at text not null)");
  const applied = new Set(
    (db.prepare("select id from migrations").all() as { id: string }[]).map((r) => r.id),
  );
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare("insert into migrations (id, at) values (?, ?)").run(m.id, new Date().toISOString());
    });
  }
}

/** Run fn in a transaction (nested calls join the outer one). */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("begin immediate");
  try {
    const out = fn();
    db.exec("commit");
    return out;
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}
