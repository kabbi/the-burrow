import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, patch, post, usd, type AiRecord, type PaperDoc, type ThingView } from "../../api.ts";
import { ago, cut, fit, plural } from "../../text.ts";
import { useTags, useTidy } from "../data.ts";
import { isDown, isEnter, isUp, useKeys, used, type Key } from "../keys.tsx";
import { useApp, useScreen, type Command } from "../state.tsx";
import { useTheme } from "../theme.ts";
import { Empty, L, Pane, Rule, windowOf, type Seg } from "../ui.tsx";
import { Preview, ThingLine } from "./Find.tsx";

// The list screens: Needs (Tidy up), Tags, Papers, AI log. Rows with section rules between them;
// ↑↓ picks, ⏎ opens.

type Entry<T> = { rule: string } | { row: T; key: string };

function useNav<T>(entries: Entry<T>[]) {
  const rows = entries.map((e, i) => ({ e, i })).filter((x) => "row" in x.e);
  const [sel, setSel] = useState(0);
  const cur = Math.min(sel, Math.max(0, rows.length - 1));
  const at = rows[cur];
  const step = (d: number) =>
    setSel((s) => Math.max(0, Math.min(rows.length - 1, Math.min(s, Math.max(0, rows.length - 1)) + d)));
  const nav = (k: Key) => {
    if (isDown(k)) return used(step(1));
    if (isUp(k)) return used(step(-1));
    if (k.name === "pagedown") return used(step(10));
    if (k.name === "pageup") return used(step(-10));
    if (k.sequence === "g") return used(setSel(0));
    if (k.sequence === "G") return used(setSel(rows.length - 1));
    return false;
  };
  return {
    cur,
    index: at?.i ?? 0,
    item: at && "row" in at.e ? at.e.row : null,
    nav,
    step,
    select: (entryIndex: number) =>
      setSel(
        Math.max(
          0,
          rows.findIndex((r) => r.i === entryIndex),
        ),
      ),
  };
}

function ListPane<T>({
  title,
  entries,
  index,
  w,
  h,
  renderRow,
  onPick,
  empty,
}: {
  title: string;
  entries: Entry<T>[];
  index: number;
  w: number;
  h: number;
  renderRow: (row: T, sel: boolean, w: number) => ReactNode;
  onPick: (entryIndex: number, isSel: boolean) => void;
  empty: string;
}) {
  const win = windowOf(entries, index, h - 2);
  const iw = w - 4;
  return (
    <Pane title={title} focused width={w} height={h}>
      {win.items.map((e, i) => {
        const at = win.start + i;
        if ("rule" in e) return <Rule key={`r${at}`} w={iw} label={e.rule} />;
        return (
          <box key={e.key} onMouseDown={() => onPick(at, at === index)}>
            {renderRow(e.row, at === index, iw)}
          </box>
        );
      })}
      {!entries.length && <Empty w={iw} text={empty} />}
    </Pane>
  );
}

// ---------------------------------------------------------------- Needs (Tidy up)

type Need =
  | { n: "thing"; t: ThingView; why: string; ai?: string[] }
  | { n: "pair"; a: ThingView; b: ThingView; why: string };

export function NeedsScreen() {
  const app = useApp();
  const th = useTheme();
  const { w, h, size } = app.area;
  const { data, isLoading } = useTidy();
  const unplaced = (data?.gaps ?? []).filter((t) => t.gaps.includes("where"));
  const fields = (data?.gaps ?? []).filter((t) => t.gaps.some((g) => g !== "where"));
  const entries: Entry<Need>[] = [];
  if (unplaced.length) {
    entries.push({ rule: `Not placed yet · ${unplaced.length}` });
    for (const t of unplaced) entries.push({ key: `u${t.id}`, row: { n: "thing", t, why: t.kind } });
  }
  if (data?.aiChecks.length) {
    entries.push({ rule: `AI guesses to check · ${data.aiChecks.length}` });
    for (const x of data.aiChecks)
      entries.push({
        key: `a${x.thing.id}`,
        row: { n: "thing", t: x.thing, why: `✦ ${x.fields.join(", ")}`, ai: x.fields },
      });
  }
  if (fields.length) {
    entries.push({ rule: `Empty wanted fields · ${fields.length}` });
    for (const t of fields)
      entries.push({
        key: `f${t.id}`,
        row: { n: "thing", t, why: t.gaps.filter((g) => g !== "where").join(", ") },
      });
  }
  if (data?.duplicates.length) {
    entries.push({ rule: `May be the same thing · ${plural(data.duplicates.length, "pair")}` });
    for (const p of data.duplicates)
      entries.push({
        key: `d${p.a.id}${p.b.id}`,
        row: {
          n: "pair",
          a: p.a,
          b: p.b,
          why:
            p.why === "name"
              ? "same name"
              : p.why === "looks"
                ? `look the same · ${Math.round((p.looks ?? 0) * 100)}%`
                : "alike",
        },
      });
  }
  const nav = useNav(entries);
  const it = nav.item;
  const thing = it?.n === "thing" ? it.t : it?.n === "pair" ? it.a : null;

  const confirmAll = (t: ThingView, f: string[]) =>
    void app.act(() => post(`/things/${t.id}/confirm`, { fields: f }), `${t.name}: all right`);
  const notSame = (a: ThingView, b: ThingView) =>
    void app.act(
      () => post(`/things/${a.id}/relations`, { type: "not_same", otherId: b.id }),
      `${a.name} and ${b.name} aren't the same`,
    );
  const commands: Command[] = thing
    ? [
        {
          section: "Selected",
          title: `Open ${thing.name}`,
          key: "⏎",
          run: () => app.go({ s: "thing", id: thing.id }),
        },
        { section: "Selected", title: `Move ${thing.name}`, key: "m", run: () => app.move([thing]) },
        ...(it?.n === "thing" && it.ai
          ? [
              {
                section: "Selected",
                title: "AI guesses are right",
                key: "Y",
                run: () => confirmAll(it.t, it.ai!),
              },
            ]
          : []),
        ...(it?.n === "pair"
          ? [{ section: "Selected", title: "Not the same thing", key: "d", run: () => notSame(it.a, it.b) }]
          : []),
      ]
    : [];
  useScreen({
    commands,
    hints: [
      ["↑↓", "pick"],
      ["⏎", "open"],
      ["m", "move"],
      ...(it?.n === "thing" && it.ai ? ([["Y", "all right"]] as [string, string][]) : []),
      ...(it?.n === "pair" ? ([["d", "not the same"]] as [string, string][]) : []),
    ],
  });
  useKeys((k) => {
    if (nav.nav(k)) return true;
    if (isEnter(k) && thing) return used(app.go({ s: "thing", id: thing.id }));
    if (k.sequence === "m" && thing) return used(app.move([thing]));
    if (k.sequence === "Y" && it?.n === "thing" && it.ai) return used(confirmAll(it.t, it.ai));
    if (k.sequence === "d" && it?.n === "pair") return used(notSame(it.a, it.b));
    return false;
  });

  const preview = size === "wide" || size === "medium";
  const pw = preview ? Math.max(36, Math.floor(w * 0.36)) : 0;
  const lw = w - (preview ? pw + 1 : 0);
  return (
    <box flexDirection="row" gap={1} width={w} height={h}>
      <ListPane
        title={
          isLoading
            ? "Needs details…"
            : `Needs details · ${(data?.gaps.length ?? 0) + (data?.aiChecks.length ?? 0)}`
        }
        entries={entries}
        index={nav.index}
        w={lw}
        h={h}
        empty="Nothing to tidy. ✓"
        onPick={(i, isSel) => (isSel && thing ? app.go({ s: "thing", id: thing.id }) : nav.select(i))}
        renderRow={(row, sel, iw) =>
          row.n === "thing" ? (
            <ThingLine t={{ ...row.t, kind: row.why }} w={iw} sel={sel} />
          ) : (
            <L
              w={iw}
              sel={sel}
              segs={[
                { t: fit(`${row.a.name} (${row.a.id})`, Math.floor((iw - 22) / 2)) },
                { t: " ⇄ ", fg: th.warn },
                { t: fit(`${row.b.name} (${row.b.id})`, Math.floor((iw - 22) / 2)) },
                { t: `  ${row.why}`, fg: th.dim },
              ]}
            />
          )
        }
      />
      {preview && <Preview id={thing?.id ?? null} w={pw} />}
    </box>
  );
}

// ---------------------------------------------------------------- Tags

export function TagsScreen() {
  const app = useApp();
  const th = useTheme();
  const { w, h } = app.area;
  const { data: tags = [], isLoading } = useTags();
  const sorted = tags.toSorted((a, b) =>
    [...a.path, a.name].join("/").localeCompare([...b.path, b.name].join("/")),
  );
  const entries: Entry<(typeof tags)[number]>[] = sorted.map((t) => ({ key: t.id, row: t }));
  const nav = useNav(entries);
  const tag = nav.item;
  const rename = () =>
    tag &&
    app.prompt({
      title: `Rename tag ${tag.name}`,
      initial: tag.name,
      onSubmit: (v) =>
        v.trim() &&
        v.trim() !== tag.name &&
        void app.act(() => patch(`/things/${tag.id}`, { name: v.trim() }), `Tag renamed to ${v.trim()}`),
    });
  useScreen({
    commands: tag
      ? [
          {
            section: "Tag",
            title: `Open ${tag.name}`,
            key: "⏎",
            run: () => app.go({ s: "thing", id: tag.id }),
          },
          { section: "Tag", title: "Rename", key: "r", run: rename },
        ]
      : [],
    hints: [
      ["↑↓", "pick"],
      ["⏎", "open"],
      ["r", "rename"],
    ],
  });
  useKeys((k) => {
    if (nav.nav(k)) return true;
    if (isEnter(k) && tag) return used(app.go({ s: "thing", id: tag.id }));
    if (k.sequence === "r") return used(rename());
    return false;
  });
  return (
    <ListPane
      title={isLoading ? "Tags…" : `Tags · ${tags.length}`}
      entries={entries}
      index={nav.index}
      w={w}
      h={h}
      empty="No tags yet."
      onPick={(i, isSel) => (isSel && tag ? app.go({ s: "thing", id: tag.id }) : nav.select(i))}
      renderRow={(t, sel, iw) => (
        <L
          w={iw}
          sel={sel}
          segs={[
            { t: "  ".repeat(t.path.length) + (t.path.length ? "└ " : "") },
            { t: fit(t.name, Math.max(10, iw - 2 * t.path.length - 30)), b: !t.path.length },
            { t: fit(String(t.uses), 6, true), fg: t.uses ? th.fg : th.dim },
            { t: t.aliases.length ? `  also ${cut(t.aliases.join(", "), 18)}` : "", fg: th.dim },
          ]}
        />
      )}
    />
  );
}

// ---------------------------------------------------------------- Papers (metadata only, D-006)

export function PapersScreen() {
  const app = useApp();
  const th = useTheme();
  const { w, h } = app.area;
  // Titles, correspondents and types only: never content, files or notes (CLAUDE.md, D-006).
  const { data, isLoading, error } = useQuery({
    queryKey: ["papers", "inbox"],
    queryFn: () => get<{ count: number; docs: PaperDoc[] }>("/papers/inbox"),
  });
  const docs = data?.docs ?? [];
  const entries: Entry<PaperDoc>[] = docs.map((d) => ({ key: String(d.id), row: d }));
  const nav = useNav(entries);
  const doc = nav.item;
  const open = () => {
    const first = doc?.things[0];
    if (first) app.go({ s: "thing", id: first.id });
    else if (doc) app.copy(app.webUrl("/papers"), "the link to file it in the web app");
  };
  useScreen({
    commands: doc
      ? [
          {
            section: "Paper",
            title: doc.things.length ? `Open ${doc.things[0]!.name}` : "Copy the web link to file it",
            key: "⏎",
            run: open,
          },
        ]
      : [],
    hints: [
      ["↑↓", "pick"],
      ["⏎", doc?.things.length ? "open its thing" : "copy web link"],
    ],
  });
  useKeys((k) => (nav.nav(k) ? true : isEnter(k) ? used(open()) : false));
  return (
    <ListPane
      title={isLoading ? "Papers inbox…" : error ? "Papers" : `Papers inbox · ${docs.length}`}
      entries={entries}
      index={nav.index}
      w={w}
      h={h}
      empty={error ? `paperless: ${(error as Error).message}` : "The inbox is empty. ✓"}
      onPick={(i) => nav.select(i)}
      renderRow={(d, sel, iw) => (
        <L
          w={iw}
          sel={sel}
          segs={[
            { t: fit(d.added.slice(0, 10), 11), fg: th.dim },
            { t: fit(d.title, Math.floor(iw * 0.45)) },
            " ",
            { t: fit(d.correspondentName ?? "—", 18), fg: th.dim },
            { t: fit(d.documentTypeName ?? "", 14), fg: th.dim },
            d.things.length
              ? { t: `→ ${d.things.map((x) => x.name).join(", ")}`, fg: th.ok }
              : { t: "not linked", fg: th.dim },
          ]}
        />
      )}
    />
  );
}

// ---------------------------------------------------------------- AI log

export function AiScreen() {
  const app = useApp();
  const th = useTheme();
  const { w, h } = app.area;
  const { data } = useQuery({
    queryKey: ["ai", "requests"],
    queryFn: () =>
      get<{ requests: AiRecord[]; spend: { totalUsd: number; monthUsd: number; runs: number } }>(
        "/ai/requests",
      ),
  });
  const reqs = data?.requests ?? [];
  const entries: Entry<AiRecord>[] = reqs.map((r) => ({ key: r.id, row: r }));
  const nav = useNav(entries);
  useScreen({ commands: [], hints: [["↑↓", "pick"]] });
  useKeys((k) => nav.nav(k));
  const s = data?.spend;
  const status = (r: AiRecord): Seg =>
    r.status === "done"
      ? { t: "✓ done", fg: th.ok }
      : r.status === "failed"
        ? { t: "✗ failed", fg: th.bad }
        : { t: r.status, fg: th.dim };
  const sel = nav.item;
  return (
    <box flexDirection="column" width={w} height={h}>
      <L
        w={w}
        segs={[
          { t: "Every quote and run. ", fg: th.dim },
          {
            t: s
              ? `This month ${usd(s.monthUsd)} · all time ${usd(s.totalUsd)} · ${plural(s.runs, "run")}`
              : "",
          },
        ]}
      />
      <ListPane
        title={`AI log · ${reqs.length}`}
        entries={entries}
        index={nav.index}
        w={w}
        h={h - (sel?.error ? 3 : 1)}
        empty="No AI requests yet."
        onPick={(i) => nav.select(i)}
        renderRow={(r, isSel, iw) => (
          <L
            w={iw}
            sel={isSel}
            segs={[
              { t: fit(ago(r.createdAt), 6), fg: th.dim },
              { t: fit(r.task, 16) },
              {
                t: fit(`${r.actualModel ?? r.model} · ${r.provider === "anthropic" ? "paid" : "local"}`, 34),
                fg: r.provider === "anthropic" ? th.warn : th.dim,
              },
              { ...status(r), t: fit(status(r).t, 10) },
              {
                t: fit(r.provider === "anthropic" ? usd(r.actualCostUsd ?? r.estCostUsd) : "free", 10, true),
              },
              {
                t: r.actualInputTokens ? `  ${r.actualInputTokens}+${r.actualOutputTokens ?? 0} tokens` : "",
                fg: th.dim,
              },
            ]}
          />
        )}
      />
      {sel?.error && <L w={w} segs={[{ t: `✗ ${sel.error}`, fg: th.bad }]} />}
    </box>
  );
}
