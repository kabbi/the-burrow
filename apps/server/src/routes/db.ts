import { Router } from "express";
import { z } from "zod";
import { BurrowError } from "@burrow/core";
import type { Deps } from "../app.ts";

// A small built-in SQLite browser (D-009). Reuses the server's connection, so
// edits are visible to the app immediately. Identifiers are checked against
// the schema; values are always bound parameters.

/** How each core table relates to the event log. */
const ROLES: Record<string, "log" | "projection" | "index" | "meta"> = {
  events: "log",
  things: "projection",
  edges: "projection",
  external_refs: "projection",
  kinds: "projection",
  things_fts: "index",
  kv: "meta",
  migrations: "meta",
  ai_requests: "meta",
};

const READ_ONLY_SQL = /^\s*(select|with|pragma|explain|values)\b/i;
const MAX_ROWS = 1000;

type Row = Record<string, unknown>;

export function dbRoutes({ store }: Deps): Router {
  const r = Router();
  const db = store.db;

  const tables = () =>
    (
      db
        .prepare(
          `select name, type, sql from sqlite_master
           where type in ('table', 'view') and name not like 'sqlite_%'
             and name not like 'things_fts_%' order by name`,
        )
        .all() as { name: string; type: string; sql: string }[]
    ).map((t) => ({ ...t, virtual: /create virtual table/i.test(t.sql ?? "") }));

  const mustTable = (name: string) => {
    const t = tables().find((x) => x.name === name);
    if (!t) throw new BurrowError(`No table ${name}`, 404);
    return t;
  };
  const columns = (name: string) =>
    db.prepare(`pragma table_xinfo("${name}")`).all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
      hidden: number;
    }[];
  const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

  r.get("/db/tables", (_req, res) => {
    res.json({
      tables: tables().map((t) => ({
        name: t.name,
        type: t.type,
        virtual: t.virtual,
        role: ROLES[t.name] ?? "other",
        rows: Number((db.prepare(`select count(*) n from ${q(t.name)}`).get() as Row).n),
        columns: columns(t.name).filter((c) => c.hidden === 0),
        sql: t.sql,
      })),
    });
  });

  r.get("/db/tables/:name", (req, res) => {
    const t = mustTable(req.params.name);
    const cols = columns(t.name).filter((c) => c.hidden === 0);
    const limit = Math.min(Number(req.query.limit ?? 100), MAX_ROWS);
    const offset = Number(req.query.offset ?? 0);
    const order = cols.some((c) => c.name === req.query.order) ? q(String(req.query.order)) : "rowid";
    const dir = req.query.dir === "desc" ? "desc" : "asc";
    const search = String(req.query.search ?? "").trim();
    const where = search ? `where ${cols.map((c) => `cast(${q(c.name)} as text) like ?`).join(" or ")}` : "";
    const args = search ? cols.map(() => `%${search}%`) : [];
    const hasRowid = t.type === "table";
    const sel = `select ${hasRowid ? "rowid as __rowid, " : ""}* from ${q(t.name)} ${where}`;
    const rows = db
      .prepare(`${sel} order by ${hasRowid || order !== "rowid" ? order : "1"} ${dir} limit ? offset ?`)
      .all(...args, limit, offset);
    const total = Number((db.prepare(`select count(*) n from ${q(t.name)} ${where}`).get(...args) as Row).n);
    res.json({
      name: t.name,
      role: ROLES[t.name] ?? "other",
      editable: hasRowid,
      columns: cols,
      rows,
      total,
    });
  });

  const Value = z.union([z.string(), z.number(), z.null()]);

  r.patch("/db/tables/:name/rows/:rowid", (req, res) => {
    const t = mustTable(req.params.name);
    const cols = columns(t.name).map((c) => c.name);
    const body = z.record(z.string(), Value).parse(req.body);
    const keys = Object.keys(body).filter((k) => cols.includes(k));
    if (!keys.length) return res.status(400).json({ error: "No known columns to update" });
    const out = db
      .prepare(`update ${q(t.name)} set ${keys.map((k) => `${q(k)} = ?`).join(", ")} where rowid = ?`)
      .run(...keys.map((k) => body[k] as string | number | null), Number(req.params.rowid));
    res.json({ changes: Number(out.changes) });
  });

  r.post("/db/tables/:name/rows", (req, res) => {
    const t = mustTable(req.params.name);
    const cols = columns(t.name).map((c) => c.name);
    const body = z.record(z.string(), Value).parse(req.body);
    const keys = Object.keys(body).filter((k) => cols.includes(k));
    const sql = keys.length
      ? `insert into ${q(t.name)} (${keys.map(q).join(", ")}) values (${keys.map(() => "?").join(", ")})`
      : `insert into ${q(t.name)} default values`;
    const out = db.prepare(sql).run(...keys.map((k) => body[k] as string | number | null));
    res.status(201).json({ rowid: Number(out.lastInsertRowid) });
  });

  r.delete("/db/tables/:name/rows/:rowid", (req, res) => {
    const t = mustTable(req.params.name);
    const out = db.prepare(`delete from ${q(t.name)} where rowid = ?`).run(Number(req.params.rowid));
    res.json({ changes: Number(out.changes) });
  });

  /** Run SQL. Anything that isn't a read needs `write: true` (a checkbox in the UI). */
  r.post("/db/query", (req, res) => {
    const b = z
      .object({ sql: z.string().min(1).max(100_000), write: z.boolean().default(false) })
      .parse(req.body);
    const readOnly = READ_ONLY_SQL.test(b.sql);
    if (!readOnly && !b.write)
      return res.status(400).json({ error: "This statement changes data. Tick “allow writes” to run it." });
    const started = performance.now();
    const stmt = db.prepare(b.sql);
    const cols = stmt.columns().map((c) => c.name);
    if (cols.length) {
      const rows = stmt.all().slice(0, MAX_ROWS);
      return res.json({
        columns: cols,
        rows,
        ms: performance.now() - started,
        truncated: rows.length === MAX_ROWS,
      });
    }
    const out = stmt.run();
    res.json({ columns: [], rows: [], changes: Number(out.changes), ms: performance.now() - started });
  });

  /** Throw away projections and replay the event log. */
  r.post("/db/rebuild", (_req, res) => {
    const started = performance.now();
    store.rebuild();
    res.json({ ok: true, ms: performance.now() - started, stats: store.stats() });
  });

  return r;
}
