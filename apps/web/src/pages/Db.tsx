import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { del, get, patch, post } from "../lib/api.ts";
import { useDebounced, useRefresh } from "../lib/hooks.ts";
import { useToast } from "../lib/toast.tsx";

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}
interface TableInfo {
  name: string;
  type: string;
  virtual: boolean;
  role: "log" | "projection" | "index" | "meta" | "other";
  rows: number;
  columns: Column[];
  sql: string;
}
interface Page {
  name: string;
  role: TableInfo["role"];
  editable: boolean;
  columns: Column[];
  rows: (Record<string, unknown> & { __rowid?: number })[];
  total: number;
}
type Cell = string | number | null;

const ROLE_NOTE: Record<TableInfo["role"], string> = {
  log: "The event log, the source of truth. Edit with care: “Rebuild” replays it into the other tables.",
  projection:
    "Derived from the event log. Edits apply right away but are lost on the next rebuild. For lasting changes, use the app or fix the events.",
  index: "Search index, derived from things. Rebuild regenerates it.",
  meta: "Bookkeeping. Usually safe to read, rarely worth editing.",
  other: "",
};

const PAGE = 100;

function show(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  return String(v);
}

/** Built-in SQLite browser (D-009). Same connection as the app. */
export function Db() {
  const [params, setParams] = useSearchParams();
  const table = params.get("t") ?? "things";
  const tab = params.get("tab") === "sql" ? "sql" : "browse";
  const set = (patchParams: Record<string, string>) =>
    setParams({ t: table, ...(tab === "sql" ? { tab } : {}), ...patchParams }, { replace: true });
  const refresh = useRefresh();
  const toast = useToast();
  const tables = useQuery({
    queryKey: ["db-tables"],
    queryFn: () => get<{ tables: TableInfo[] }>("/db/tables"),
  });

  async function rebuild() {
    if (
      !confirm(
        "Drop all derived tables and replay the event log? Direct edits to derived tables will be lost.",
      )
    )
      return;
    try {
      const r = await post<{ ms: number; stats: { things: number; events: number } }>("/db/rebuild");
      toast({ text: `Rebuilt from ${r.stats.events} events in ${Math.round(r.ms)} ms` });
      await refresh();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  }

  return (
    <main className="page wide">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ fontSize: 34 }}>Database</h1>
        <div className="row">
          <span className="muted small mono">data/burrow.sqlite</span>
          <button type="button" className="btn small" onClick={rebuild}>
            Rebuild from events
          </button>
        </div>
      </div>
      <div className="dbgrid">
        <nav className="folders" aria-label="Tables">
          <button
            type="button"
            aria-pressed={tab === "sql"}
            onClick={() => setParams({ t: table, tab: "sql" }, { replace: true })}
          >
            <span>SQL console</span>
          </button>
          <h3>Tables</h3>
          {tables.data?.tables.map((t) => (
            <button
              key={t.name}
              type="button"
              aria-pressed={tab === "browse" && t.name === table}
              onClick={() => setParams({ t: t.name }, { replace: true })}
              title={t.role}
            >
              <span>
                {t.name}
                {t.role === "log" && (
                  <span className="tag" style={{ marginLeft: 6 }}>
                    log
                  </span>
                )}
              </span>
              <span className="small">{t.rows}</span>
            </button>
          ))}
        </nav>
        <section style={{ minWidth: 0 }}>
          {tab === "sql" ? (
            <SqlConsole />
          ) : (
            <Browse
              key={table}
              table={table}
              info={tables.data?.tables.find((t) => t.name === table)}
              onSet={set}
              params={params}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function Browse({
  table,
  info,
  params,
  onSet,
}: {
  table: string;
  info: TableInfo | undefined;
  params: URLSearchParams;
  onSet: (p: Record<string, string>) => void;
}) {
  const refresh = useRefresh();
  const toast = useToast();
  const offset = Number(params.get("o") ?? 0);
  const order = params.get("order") ?? "";
  const dir = params.get("dir") === "desc" ? "desc" : "asc";
  const [search, setSearch] = useState(params.get("q") ?? "");
  const dq = useDebounced(search.trim(), 250);
  const [editing, setEditing] = useState<{ rowid: number; col: Column; value: unknown } | null>(null);
  const [showSchema, setShowSchema] = useState(false);

  const qs = new URLSearchParams({
    limit: String(PAGE),
    offset: String(offset),
    ...(order ? { order, dir } : {}),
    ...(dq ? { search: dq } : {}),
  });
  const page = useQuery({
    queryKey: ["db-page", table, qs.toString()],
    queryFn: () => get<Page>(`/db/tables/${encodeURIComponent(table)}?${qs}`),
    placeholderData: (prev) => prev,
  });
  const p = page.data;

  async function remove(rowid: number) {
    if (!confirm(`Delete row ${rowid} from ${table}?`)) return;
    try {
      await del(`/db/tables/${encodeURIComponent(table)}/rows/${rowid}`);
      toast({ text: `Deleted row ${rowid}` });
      await refresh();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  }

  const sortBy = (c: string) =>
    onSet({ order: c, dir: order === c && dir === "asc" ? "desc" : "asc", ...(dq ? { q: dq } : {}) });

  return (
    <div className="stack">
      {info && ROLE_NOTE[info.role] && <p className={`dbnote ${info.role}`}>{ROLE_NOTE[info.role]}</p>}
      <div className="row">
        <input
          className="input"
          style={{ maxWidth: 360 }}
          placeholder={`Search ${table}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={`Search ${table}`}
        />
        <span className="muted small">
          {p
            ? `${p.total} rows${p.total > PAGE ? ` · ${offset + 1}–${Math.min(offset + PAGE, p.total)}` : ""}`
            : ""}
        </span>
        <span className="grow" />
        <button
          type="button"
          className="btn small"
          disabled={offset === 0}
          onClick={() => onSet({ o: String(Math.max(0, offset - PAGE)), ...(order ? { order, dir } : {}) })}
        >
          ‹ Prev
        </button>
        <button
          type="button"
          className="btn small"
          disabled={!p || offset + PAGE >= p.total}
          onClick={() => onSet({ o: String(offset + PAGE), ...(order ? { order, dir } : {}) })}
        >
          Next ›
        </button>
        <button type="button" className="btn small" onClick={() => setShowSchema((s) => !s)}>
          Schema
        </button>
      </div>
      {showSchema && info && <pre className="dbschema">{info.sql}</pre>}
      {p && (
        <div className="dbtable-wrap">
          <table className="dbtable">
            <thead>
              <tr>
                {p.editable && <th aria-label="Row actions" />}
                {p.columns.map((c) => (
                  <th key={c.name}>
                    <button
                      type="button"
                      onClick={() => sortBy(c.name)}
                      title={`${c.type || "any"}${c.pk ? " · primary key" : ""}`}
                    >
                      {c.name}
                      {order === c.name ? (dir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.rows.map((row, i) => (
                <tr key={row.__rowid ?? i}>
                  {p.editable && (
                    <td className="dbactions">
                      <button
                        type="button"
                        aria-label={`Delete row ${row.__rowid}`}
                        onClick={() => remove(row.__rowid!)}
                      >
                        ×
                      </button>
                    </td>
                  )}
                  {p.columns.map((c) => {
                    const v = row[c.name];
                    return (
                      <td key={c.name} className={v === null ? "null" : typeof v === "number" ? "num" : ""}>
                        {p.editable ? (
                          <button
                            type="button"
                            onClick={() => setEditing({ rowid: row.__rowid!, col: c, value: v })}
                            title={show(v)}
                          >
                            {show(v)}
                          </button>
                        ) : (
                          <span title={show(v)}>{show(v)}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {p.rows.length === 0 && <div className="empty">No rows.</div>}
        </div>
      )}
      {editing && <CellEditor table={table} edit={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CellEditor({
  table,
  edit,
  onClose,
}: {
  table: string;
  edit: { rowid: number; col: Column; value: unknown };
  onClose: () => void;
}) {
  const refresh = useRefresh();
  const toast = useToast();
  const ref = useRef<HTMLDialogElement>(null);
  const isJson = typeof edit.value === "string" && /^[[{]/.test(edit.value);
  const pretty = isJson ? safePretty(edit.value as string) : edit.value === null ? "" : String(edit.value);
  const [text, setText] = useState(pretty);
  const [isNull, setNull] = useState(edit.value === null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function save() {
    let v: Cell;
    const numeric = /int|real|num|float|double/i.test(edit.col.type);
    if (isNull) v = null;
    else if (numeric && text.trim() !== "" && !Number.isNaN(Number(text))) v = Number(text);
    else if (isJson) {
      try {
        v = JSON.stringify(JSON.parse(text)); // keep JSON columns compact and valid
      } catch {
        toast({ text: "That isn't valid JSON", error: true });
        return;
      }
    } else v = text;
    try {
      await patch(`/db/tables/${encodeURIComponent(table)}/rows/${edit.rowid}`, { [edit.col.name]: v });
      toast({ text: `${table}.${edit.col.name} updated (row ${edit.rowid})` });
      await refresh();
      onClose();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  }

  return (
    <dialog ref={ref} className="dbdialog" onClose={onClose}>
      <form
        method="dialog"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <strong>
          {table}.{edit.col.name}{" "}
          <span className="muted small">
            row {edit.rowid} · {edit.col.type || "any"}
            {isJson ? " · JSON" : ""}
          </span>
        </strong>
        <textarea
          className="input mono"
          rows={isJson ? 14 : 4}
          value={text}
          disabled={isNull}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save();
          }}
          aria-label="Value"
        />
        <label className="row small">
          <input type="checkbox" checked={isNull} onChange={(e) => setNull(e.target.checked)} /> NULL
        </label>
        <div className="row">
          <button type="submit" className="btn main">
            Save (Ctrl+Enter)
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

function safePretty(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function SqlConsole() {
  const refresh = useRefresh();
  const [sql, setSql] = useState(() => {
    try {
      return (
        localStorage.getItem("burrow.db.sql") ??
        "select id, kind, name, parent_id from things order by seq desc limit 50"
      );
    } catch {
      return "select id, kind, name, parent_id from things order by seq desc limit 50";
    }
  });
  const [write, setWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{
    columns: string[];
    rows: Record<string, unknown>[];
    ms: number;
    changes?: number;
    truncated?: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem("burrow.db.sql", sql);
    } catch {
      // storage unavailable: nothing to remember
    }
    try {
      const r = await post<NonNullable<typeof res>>("/db/query", { sql, write });
      setRes(r);
      if (r.changes !== undefined) await refresh();
    } catch (e) {
      setError((e as Error).message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <textarea
        className="input mono"
        rows={6}
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void run();
          }
        }}
        aria-label="SQL"
        spellCheck={false}
      />
      <div className="row">
        <button type="button" className="btn main" onClick={run} disabled={busy}>
          {busy ? "Running…" : "Run (Ctrl+Enter)"}
        </button>
        <label className="row small">
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> allow writes
          (INSERT / UPDATE / DELETE / DDL)
        </label>
        <span className="muted small">One statement at a time. Reads return at most 1000 rows.</span>
      </div>
      {error && <p className="dbnote log">{error}</p>}
      {res && (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            {res.changes !== undefined
              ? `${res.changes} rows changed`
              : `${res.rows.length} rows${res.truncated ? " (truncated)" : ""}`}{" "}
            · {res.ms.toFixed(1)} ms
          </p>
          {res.columns.length > 0 && (
            <div className="dbtable-wrap">
              <table className="dbtable">
                <thead>
                  <tr>
                    {res.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {res.rows.map((r, i) => (
                    <tr key={i}>
                      {res.columns.map((c) => (
                        <td
                          key={c}
                          className={r[c] === null ? "null" : typeof r[c] === "number" ? "num" : ""}
                        >
                          <span title={show(r[c])}>{show(r[c])}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
