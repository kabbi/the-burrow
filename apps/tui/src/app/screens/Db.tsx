import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { asId, get, post } from "../../api.ts";
import { cut, fit, plural } from "../../text.ts";
import { isEnter, useKeys, useLine, used } from "../keys.tsx";
import { LineView } from "../modals.tsx";
import { useApp, useScreen, type Command } from "../state.tsx";
import { useTheme } from "../theme.ts";
import { Empty, kc, L, Pane, windowOf } from "../ui.tsx";

// The database (D-009): tables, a grid, read-only SQL (W allows writes), rebuild from events.
// The grid is for looking: changes to things go through their screens, so they stay events.

interface Table {
  name: string;
  role: "log" | "projection" | "index" | "meta" | "other";
  rows: number;
  columns: { name: string; type: string }[];
}
interface Rows {
  columns: { name: string }[];
  rows: Record<string, unknown>[];
  total: number;
}
interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  ms: number;
  changes?: number;
  truncated?: boolean;
}

const PAGE = 200;
const RANK: Record<Table["role"], number> = { log: 0, projection: 1, index: 2, meta: 3, other: 4 };
const cell = (v: unknown) =>
  v === null || v === undefined
    ? "∅"
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v).replace(/\s+/g, " ");

function Grid({
  columns,
  rows,
  w,
  h,
  cur,
  focused,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  w: number;
  h: number;
  cur: { r: number; c: number } | null;
  focused: boolean;
}) {
  const th = useTheme();
  // Columns as wide as their content (up to 40), scrolled so the cursor's column shows.
  const widths = columns.map((c) =>
    Math.min(40, Math.max(c.length, ...rows.slice(0, 50).map((r) => cell(r[c]).length)) + 1),
  );
  let first = 0;
  if (cur) {
    let span = 0;
    for (let i = cur.c; i >= 0; i--) {
      span += widths[i]! + 1;
      if (span > w) break;
      first = i;
    }
  }
  const shown: number[] = [];
  let taken = 0;
  for (let i = first; i < columns.length && taken + widths[i]! + 1 <= w; i++) {
    shown.push(i);
    taken += widths[i]! + 1;
  }
  const win = windowOf(rows, cur?.r ?? 0, h - 1);
  return (
    <box flexDirection="column">
      <L w={w} segs={shown.map((i) => ({ t: `${fit(columns[i]!, widths[i]!)} `, fg: th.dim }))} />
      {win.items.map((r, k) => {
        const ri = win.start + k;
        return (
          <L
            key={ri}
            w={w}
            segs={shown.map((i) => {
              const on = focused && cur?.r === ri && cur.c === i;
              const v = cell(r[columns[i]!]);
              return {
                t: `${fit(v, widths[i]!)} `,
                ...(on ? { bg: th.selBg, fg: th.selFg } : cur?.r === ri && focused ? { bg: th.key } : {}),
                ...(v === "∅" && !on ? { fg: th.dim } : {}),
              };
            })}
          />
        );
      })}
    </box>
  );
}

const move = (
  set: (f: (c: { r: number; c: number }) => { r: number; c: number }) => void,
  nr: number,
  nc: number,
  dr: number,
  dc: number,
) => set((c) => ({ r: Math.max(0, Math.min(nr - 1, c.r + dr)), c: Math.max(0, Math.min(nc - 1, c.c + dc)) }));

export function DbScreen() {
  const app = useApp();
  const th = useTheme();
  const qc = useQueryClient();
  const { w, h } = app.area;
  const [pane, setPane] = useState<"tables" | "grid" | "sql">("tables");
  const [tsel, setTsel] = useState<number | null>(null);
  const [gcur, setGcur] = useState({ r: 0, c: 0 });
  const [offset, setOffset] = useState(0);
  const [writes, setWrites] = useState(false);
  const [rebuildArmed, setRebuildArmed] = useState(false);
  const sql = useLine("select kind, count(*) as n from things group by kind order by n desc");
  const [result, setResult] = useState<QueryResult | { error: string } | null>(null);
  const [rcur, setRcur] = useState({ r: 0, c: 0 });

  const tables = useQuery({
    queryKey: ["db", "tables"],
    queryFn: async () => (await get<{ tables: Table[] }>("/db/tables")).tables,
  });
  const list = (tables.data ?? []).toSorted(
    (a, b) => RANK[a.role] - RANK[b.role] || a.name.localeCompare(b.name),
  );
  // Open on "things" until someone picks another table.
  const tcur =
    tsel ??
    Math.max(
      0,
      list.findIndex((t) => t.name === "things"),
    );
  const table = list[Math.min(tcur, list.length - 1)] ?? null;
  const rows = useQuery({
    queryKey: ["db", "rows", table?.name, offset],
    queryFn: () =>
      get<Rows>(
        `/db/tables/${table!.name}?limit=${PAGE}&offset=${offset}${table!.name === "events" ? "&order=seq&dir=desc" : ""}`,
      ),
    enabled: Boolean(table),
  });
  const gcols = rows.data?.columns.map((c) => c.name) ?? [];
  const grows = rows.data?.rows ?? [];

  async function run() {
    const text = sql.value.trim();
    if (!text) return;
    try {
      const r = await post<QueryResult>("/db/query", { sql: text, write: writes });
      setResult(r);
      setRcur({ r: 0, c: 0 });
      if (r.changes) {
        await qc.invalidateQueries();
        app.toast(`${plural(r.changes, "row")} changed directly (not events: a rebuild discards it)`, "info");
      }
    } catch (e) {
      setResult({ error: (e as Error).message });
    }
  }
  function rebuild() {
    if (!rebuildArmed) {
      setRebuildArmed(true);
      app.toast("Press R again to rebuild every projection from the event log");
      setTimeout(() => setRebuildArmed(false), 4000);
      return;
    }
    setRebuildArmed(false);
    void post<{ ms: number }>("/db/rebuild").then(
      async (r) => {
        await qc.invalidateQueries();
        app.toast(`Rebuilt from events in ${Math.round(r.ms)} ms`, "ok");
      },
      (e: Error) => app.toast(e.message, "error"),
    );
  }
  const cellAt = (src: "grid" | "sql") => {
    if (src === "grid") return grows[gcur.r]?.[gcols[gcur.c] ?? ""];
    if (!result || "error" in result) return undefined;
    return result.rows[rcur.r]?.[result.columns[rcur.c] ?? ""];
  };
  const openCell = (v: unknown) => {
    const id = typeof v === "string" && /^B-\d+$/.test(v) ? asId(v) : null;
    if (id) app.go({ s: "thing", id });
    else app.toast("That cell isn't a thing ID");
  };

  const commands: Command[] = [
    { section: "Database", title: "Run SQL", key: "⌃E", run: () => void run() },
    {
      section: "Database",
      title: writes ? "Back to read-only" : "Allow writes in SQL",
      key: "W",
      run: () => setWrites(!writes),
    },
    {
      section: "Database",
      title: "Rebuild everything from events",
      key: "R",
      also: "replay projections",
      run: rebuild,
    },
    {
      section: "Database",
      title: "Copy this cell",
      key: "y",
      run: () => app.copy(cell(cellAt(pane === "sql" ? "sql" : "grid")), "the cell"),
    },
  ];
  useScreen({
    commands,
    hints:
      pane === "sql"
        ? [
            ["⏎", "run"],
            ["↑↓", "rows"],
            ["tab", "tables"],
            ["esc", "tables"],
          ]
        : pane === "grid"
          ? [
              ["hjkl", "cell"],
              ["o", "open thing"],
              ["y", "copy cell"],
              [":", "SQL"],
              ["n/p", "page"],
              ["W", "allow writes"],
              ["R", "rebuild"],
            ]
          : [
              ["↑↓", "table"],
              ["⏎", "rows"],
              [":", "SQL"],
              ["W", "allow writes"],
              ["R", "rebuild"],
            ],
  });

  function gridKeys(
    k: Parameters<Parameters<typeof useKeys>[0]>[0],
    set: typeof setGcur,
    nr: number,
    nc: number,
  ) {
    if (k.name === "down" || k.sequence === "j") return used(move(set, nr, nc, 1, 0));
    if (k.name === "up" || k.sequence === "k") return used(move(set, nr, nc, -1, 0));
    if (k.name === "right" || k.sequence === "l") return used(move(set, nr, nc, 0, 1));
    if (k.name === "left" || k.sequence === "h") return used(move(set, nr, nc, 0, -1));
    if (k.name === "pagedown") return used(move(set, nr, nc, 10, 0));
    if (k.name === "pageup") return used(move(set, nr, nc, -10, 0));
    return false;
  }

  useKeys(
    (k) => {
      if (k.name === "tab")
        return used(setPane(pane === "tables" ? "grid" : pane === "grid" ? "sql" : "tables"));
      if (pane === "sql") {
        if (isEnter(k) || (k.ctrl && k.name === "e")) return used(run());
        if (k.name === "escape") return used(setPane("tables"));
        if (
          result &&
          !("error" in result) &&
          (k.name === "down" || k.name === "up" || k.name === "pagedown" || k.name === "pageup")
        )
          return gridKeys(k, setRcur, result.rows.length, result.columns.length);
        sql.edit(k);
        return true;
      }
      if (k.sequence === ":") return used(setPane("sql"));
      if (k.sequence === "W") return used(setWrites(!writes));
      if (k.sequence === "R") return used(rebuild());
      if (k.ctrl && k.name === "e") return used(run());
      if (pane === "tables") {
        if (k.name === "down" || k.sequence === "j")
          return used((setTsel(Math.min(list.length - 1, tcur + 1)), setOffset(0), setGcur({ r: 0, c: 0 })));
        if (k.name === "up" || k.sequence === "k")
          return used((setTsel(Math.max(0, tcur - 1)), setOffset(0), setGcur({ r: 0, c: 0 })));
        if (isEnter(k) || k.name === "right" || k.sequence === "l") return used(setPane("grid"));
        return false;
      }
      if (k.name === "escape") return used(setPane("tables"));
      if (k.sequence === "y") return used(app.copy(cell(cellAt("grid")), "the cell"));
      if (k.sequence === "o" || isEnter(k)) return used(openCell(cellAt("grid")));
      if (k.sequence === "n" && rows.data && offset + PAGE < rows.data.total)
        return used((setOffset(offset + PAGE), setGcur({ r: 0, c: gcur.c })));
      if (k.sequence === "p" && offset > 0)
        return used((setOffset(Math.max(0, offset - PAGE)), setGcur({ r: 0, c: gcur.c })));
      return gridKeys(k, setGcur, grows.length, gcols.length);
    },
    { paste: (t) => (pane === "sql" ? (sql.insert(t), true) : false) },
  );

  if (tables.error)
    return (
      <Empty
        w={w}
        text={`The database browser is off on this server (${(tables.error as Error).message}).`}
      />
    );

  const lw = 26;
  const rw = w - lw - 1;
  const sqlH = Math.max(7, Math.floor(h * 0.34));
  const gridH = h - sqlH - 1;
  return (
    <box flexDirection="column" width={w} height={h}>
      <L
        w={w}
        segs={[
          { t: "burrow.sqlite · ", fg: th.dim },
          writes ? { t: "▲ writes allowed", fg: th.warn, b: true } : { t: "● read-only", fg: th.ok },
          "   ",
          kc(th, "W"),
          { t: writes ? " back to read-only" : " allow writes", fg: th.dim },
          "   ",
          kc(th, "R"),
          {
            t: rebuildArmed ? " press again to rebuild" : " rebuild from events",
            fg: rebuildArmed ? th.warn : th.dim,
          },
        ]}
      />
      <box flexDirection="row" gap={1} height={h - 1}>
        <Pane title="Tables" focused={pane === "tables"} width={lw}>
          {list.map((t, i) => {
            const head =
              t.role !== list[i - 1]?.role
                ? t.role === "log"
                  ? "source of truth"
                  : t.role === "projection"
                    ? "projections"
                    : t.role
                : null;
            return (
              <box key={t.name} flexDirection="column">
                {head && <L w={lw - 4} segs={[{ t: head, fg: th.dim }]} />}
                <L
                  w={lw - 4}
                  sel={pane === "tables" && i === tcur}
                  {...(pane !== "tables" && i === tcur ? { bg: th.key } : {})}
                  onClick={() => (setTsel(i), setPane("tables"))}
                  segs={[
                    { t: fit(t.name, lw - 12), b: i === tcur },
                    { t: fit(t.rows.toLocaleString(), 7, true), fg: th.dim },
                  ]}
                />
              </box>
            );
          })}
        </Pane>
        <box flexDirection="column" width={rw} gap={0}>
          <Pane
            title={
              table
                ? `${table.name} · ${plural(rows.data?.total ?? table.rows, "row")}${offset ? ` · from ${offset + 1}` : ""}`
                : "Rows"
            }
            focused={pane === "grid"}
            height={gridH}
          >
            {rows.data ? (
              <Grid
                columns={gcols}
                rows={grows}
                w={rw - 4}
                h={gridH - 2}
                cur={gcur}
                focused={pane === "grid"}
              />
            ) : (
              <Empty w={rw - 4} text="…" />
            )}
          </Pane>
          <Pane
            title={`SQL · ⌃E run · ${writes ? "writes allowed" : "read-only"}`}
            focused={pane === "sql"}
            height={sqlH}
            flexGrow={1}
          >
            <LineView line={sql} w={rw - 4} active={pane === "sql"} />
            {result && "error" in result ? (
              <L w={rw - 4} segs={[{ t: `✗ ${cut(result.error, rw - 8)}`, fg: th.bad }]} />
            ) : result ? (
              <>
                <L
                  w={rw - 4}
                  segs={[
                    { t: "✓ ", fg: th.ok },
                    {
                      t: `${plural(result.rows.length, "row")}${result.truncated ? " (cut)" : ""}${result.changes !== undefined ? ` · ${plural(result.changes, "change")}` : ""} · ${result.ms.toFixed(1)} ms`,
                      fg: th.dim,
                    },
                  ]}
                />
                <Grid
                  columns={result.columns}
                  rows={result.rows}
                  w={rw - 4}
                  h={sqlH - 4}
                  cur={rcur}
                  focused={pane === "sql"}
                />
              </>
            ) : (
              <L w={rw - 4} segs={[{ t: ": or tab to type SQL, ⏎ runs it", fg: th.dim }]} />
            )}
          </Pane>
        </box>
      </box>
    </box>
  );
}
