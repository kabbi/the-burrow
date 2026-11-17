import { useState } from "react";
import {
  eventLabel,
  patch,
  post,
  put,
  ROLE_LABEL,
  type KindField,
  type RelationView,
  type ThingDetail,
  type ThingView,
} from "../../api.ts";
import { ago, cut, fit, hasWhere, plural, valueText, whereText } from "../../text.ts";
import { stepText, useAiOptions, useSuggest, type AiOption } from "../ai.ts";
import { useSchema, useThing } from "../data.ts";
import { isDown, isEnter, isUp, useKeys, used } from "../keys.tsx";
import { useApp, useScreen, type Command } from "../state.tsx";
import { useTheme } from "../theme.ts";
import { Empty, kc, kcAi, L, Pane, Rule, stateSeg, windowOf, type Seg } from "../ui.tsx";

// One thing: its facts, each with where the value came from; AI guesses in violet with
// y (right) / n (wrong); links, what's inside, pictures, and history with undo on each line.

/** Links the thing page doesn't list (D-034, D-036). */
const HIDDEN_LINKS = new Set(["tagged", "not_same", "split_from", "merged_into"]);

type Row =
  | { r: "name" }
  | { r: "kind" }
  | { r: "field"; key: string; f?: KindField }
  | { r: "tags" }
  | { r: "link"; rel: RelationView }
  | { r: "thing"; t: ThingView; why: string };
type Item = Row | { r: "rule"; label: string };

const LABELS: Record<string, string> = {
  url: "Link",
  quantity: "Quantity",
  aliases: "Also called",
  notes: "Notes",
};
const label = (key: string, f?: KindField) =>
  f?.label ?? LABELS[key] ?? key.replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase());

/** What was typed → the field's value type (the server validates), like the web app's Facts. */
export function parseInput(raw: string, f: KindField | undefined, old: unknown): unknown {
  const t = raw.trim();
  if (t === "") return null;
  const type = f?.type ?? (typeof old === "number" ? "number" : Array.isArray(old) ? "list" : "text");
  if (type === "number" || type === "money") return Number(t.replace(",", "."));
  if (type === "boolean") return /^(y|yes|true|1|on)$/i.test(t);
  if (type === "list")
    return t
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return t;
}

function itemsOf(d: ThingDetail): Item[] {
  const t = d.thing;
  const declared = new Set(d.fields.map((f) => f.key));
  const extra = Object.keys(t.data).filter((k) => !declared.has(k));
  const out: Item[] = [
    { r: "name" },
    { r: "kind" },
    ...d.fields.map((f): Row => ({ r: "field", key: f.key, f })),
    ...extra.map((key): Row => ({ r: "field", key })),
  ];
  if (t.kind !== "tag") out.push({ r: "tags" });
  const links = d.relations.filter((x) => !HIDDEN_LINKS.has(x.type));
  if (links.length) out.push({ r: "rule", label: "Links" }, ...links.map((rel): Row => ({ r: "link", rel })));
  if (d.stock.length)
    out.push(
      { r: "rule", label: "Same stock" },
      ...d.stock.map((s): Row => ({ r: "thing", t: s, why: whereText(s) })),
    );
  if (d.children.length)
    out.push(
      { r: "rule", label: `Inside · ${d.children.length}` },
      ...d.children.map((c): Row => ({ r: "thing", t: c, why: c.kind })),
    );
  if (d.tagged.length)
    out.push(
      { r: "rule", label: `Tagged · ${d.tagged.length}` },
      ...d.tagged.map((c): Row => ({ r: "thing", t: c, why: whereText(c) })),
    );
  return out;
}

export function ThingScreen({ id }: { id: string }) {
  const { data, error } = useThing(id);
  const app = useApp();
  const th = useTheme();
  if (error) return <Empty w={app.area.w} text={`${id}: ${(error as Error).message}`} />;
  if (!data) return <Empty w={app.area.w} text={`Opening ${id}…`} />;
  if (data.mergedInto) {
    return (
      <box flexDirection="column">
        <L
          w={app.area.w}
          segs={[
            { t: `${id} was put together into ${data.mergedInto}. `, fg: th.dim },
            kc(th, "⏎"),
            { t: " open it", fg: th.dim },
          ]}
        />
        <Redirect to={data.mergedInto} />
      </box>
    );
  }
  return <ThingView d={data} />;
}

function Redirect({ to }: { to: string }) {
  const app = useApp();
  useKeys((k) => (isEnter(k) ? (app.go({ s: "thing", id: to }), true) : false));
  return null;
}

function ThingView({ d }: { d: ThingDetail }) {
  const app = useApp();
  const th = useTheme();
  const t = d.thing;
  const { w, h, size } = app.area;
  const items = itemsOf(d);
  const rows = items.map((it, i) => ({ it, i })).filter((x) => x.it.r !== "rule");
  const [sel, setSel] = useState(0);
  const [hsel, setHsel] = useState(0);
  const [pane, setPane] = useState<"facts" | "history">("facts");
  const cur = Math.min(sel, rows.length - 1);
  const row = rows[cur]?.it as Row | undefined;
  const { data: schema } = useSchema();
  const ai = useAiOptions();
  const suggest = useSuggest(t);
  const events = d.events;
  const hcur = Math.min(hsel, Math.max(0, events.length - 1));

  const keyOf = (r: Row | undefined) =>
    r?.r === "field" ? r.key : r?.r === "name" ? "name" : r?.r === "kind" ? "kind" : null;
  const isGuess = (key: string | null) =>
    Boolean(key && t.meta[key]?.source === "ai" && !t.meta[key]?.confirmed);
  const aiTags = t.tags.filter((g) => g.source === "ai");
  const guesses = Object.keys(t.meta).filter((k) => isGuess(k));
  const group = `review:${t.id}`;

  const right = (r: Row | undefined) => {
    if (r?.r === "tags" && aiTags.length)
      return void app.act(
        async () => {
          for (const g of aiTags) await post(`/things/${t.id}/tags/${g.id}/confirm`);
          return {};
        },
        `Confirmed tags ${aiTags.map((g) => g.name).join(", ")}`,
        { group },
      );
    const key = keyOf(r);
    if (!key || !isGuess(key)) return;
    void app.act(
      () => post(`/things/${t.id}/confirm`, { fields: [key] }),
      `Confirmed ${label(key, r?.r === "field" ? r.f : undefined)}`,
      { group },
    );
  };
  const wrong = (r: Row | undefined) => {
    if (r?.r === "tags" && aiTags.length)
      return void app.act(
        () =>
          put(`/things/${t.id}/tags`, { names: t.tags.filter((g) => g.source !== "ai").map((g) => g.name) }),
        `Removed tags ${aiTags.map((g) => g.name).join(", ")}`,
        { group },
      );
    const key = keyOf(r);
    if (!key || !isGuess(key)) return;
    if (key === "name" || key === "kind") return edit(r);
    void app.act(() => patch(`/things/${t.id}`, { data: { [key]: null } }), `Removed ${label(key)}`, {
      group,
    });
  };
  const allRight = () =>
    guesses.length || aiTags.length
      ? void app.act(
          async () => {
            const r = guesses.length ? await post(`/things/${t.id}/confirm`, { fields: guesses }) : {};
            for (const g of aiTags) await post(`/things/${t.id}/tags/${g.id}/confirm`);
            return r;
          },
          `All right: ${[...guesses.map((k) => label(k)), ...(aiTags.length ? ["tags"] : [])].join(", ")}`,
        )
      : app.toast("No AI guesses to check here");

  function edit(r: Row | undefined) {
    if (!r) return;
    if (r.r === "link") return app.go({ s: "thing", id: r.rel.other.id });
    if (r.r === "thing") return app.go({ s: "thing", id: r.t.id });
    if (r.r === "name")
      return app.prompt({
        title: "Name",
        initial: t.name,
        onSubmit: (v) =>
          v.trim() &&
          v.trim() !== t.name &&
          void app.act(() => patch(`/things/${t.id}`, { name: v.trim() }), `Renamed to ${v.trim()}`),
      });
    if (r.r === "kind") {
      const kinds = (schema?.kinds ?? []).filter((k) => !k.isTag && !k.isDocument).map((k) => k.id);
      return app.prompt({
        title: "Kind",
        initial: t.kind,
        hint: cut(kinds.join(" · "), 60),
        onSubmit: (v) =>
          v.trim() &&
          v.trim() !== t.kind &&
          void app.act(() => patch(`/things/${t.id}`, { kind: v.trim() }), `Kind → ${v.trim()}`),
      });
    }
    if (r.r === "tags")
      return app.prompt({
        title: "Tags (comma-separated)",
        initial: t.tags.map((g) => g.name).join(", "),
        hint: "new names become new tags",
        onSubmit: (v) =>
          void app.act(
            () =>
              put(`/things/${t.id}/tags`, {
                names: v
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              }),
            "Tags saved",
          ),
      });
    const old = t.data[r.key];
    if (r.f?.type === "boolean")
      return void app.act(
        () => patch(`/things/${t.id}`, { data: { [r.key]: !old } }),
        `${label(r.key, r.f)}: ${old ? "no" : "yes"}`,
      );
    app.prompt({
      title: label(r.key, r.f),
      initial: Array.isArray(old) ? old.join(", ") : old === null || old === undefined ? "" : String(old),
      hint:
        r.f?.type === "select"
          ? (r.f.options ?? []).join(" · ")
          : r.f?.type === "list"
            ? "comma-separated"
            : r.f?.unit
              ? `in ${r.f.unit}`
              : (r.f?.type ?? ""),
      onSubmit: (v) =>
        void app.act(
          () => patch(`/things/${t.id}`, { data: { [r.key]: parseInput(v, r.f, old) } }),
          `Saved ${label(r.key, r.f)}`,
        ),
    });
  }

  const notHere = () =>
    void app.act(
      () => post(`/things/${t.id}/status`, { status: t.status === "missing" ? "ok" : "missing" }),
      t.status === "missing" ? `Found ${t.name}` : `${t.name}: not here (missing)`,
    );
  const spot = () =>
    t.parentId
      ? app.prompt({
          title: "Spot inside the place",
          initial: t.position ?? "",
          hint: d.spots.length ? `used here: ${d.spots.join(" · ")}` : 'e.g. "shelf 3", "front left"',
          onSubmit: (v) =>
            void app.act(
              () => post(`/things/${t.id}/move`, { to: t.parentId, position: v.trim() || null }),
              v.trim() ? `Spot: ${v.trim()}` : "Spot cleared",
            ),
        })
      : app.toast("Put it somewhere first (m)");
  const toggleEvent = (seq: number, undone: boolean) =>
    void app.act(() => post(`/events/${seq}/undo`), undone ? `Redid #${seq}` : `Undid #${seq}`);
  const suggestWith = (o: AiOption | null) => void suggest.start(o);

  const commands: Command[] = [
    { section: "This thing", title: "Move it", key: "m", run: () => app.move([t]) },
    {
      section: "This thing",
      title: t.status === "missing" ? "Found it" : "It's not here",
      key: "x",
      run: notHere,
    },
    { section: "This thing", title: "Set the spot", key: "+", run: spot },
    { section: "This thing", title: "Rename", run: () => edit({ r: "name" }) },
    { section: "This thing", title: "Edit tags", key: "t", run: () => edit({ r: "tags" }) },
    { section: "This thing", title: "All AI guesses are right", key: "Y", run: allRight },
    ...ai.options.map((o): Command => ({
      section: "This thing",
      title: `Suggest details · ${o.label}`,
      ...(o === ai.preferred ? { key: "s" } : {}),
      also: "ai",
      run: () => suggestWith(o),
    })),
    { section: "This thing", title: `Copy ID ${t.id}`, key: "#", run: () => app.copy(t.id) },
    {
      section: "This thing",
      title: "Copy its web link",
      key: "o",
      run: () => app.copy(app.webUrl(`/things/${t.id}`), "the link"),
    },
    {
      section: "This thing",
      title: "Archive it",
      also: "delete remove",
      run: () => void app.act(() => post(`/things/${t.id}/archive`), `Archived ${t.name}`),
    },
  ];
  useScreen({
    commands,
    hints:
      suggest.step.s === "quoted"
        ? [
            ["⏎", "run (paid)"],
            ["esc", "cancel"],
          ]
        : pane === "history"
          ? [
              ["↑↓", "event"],
              ["⏎", "undo / redo it"],
              ["tab", "facts"],
              ["esc", "back"],
            ]
          : [
              ["↑↓", "field"],
              ["⏎", "edit"],
              ["y", "right"],
              ["n", "wrong"],
              ["Y", "all right"],
              ["s", "suggest"],
              ["m", "move"],
              ["x", "not here"],
              ["tab", "history"],
              ["esc", "back"],
            ],
  });

  useKeys((k) => {
    if (suggest.step.s === "quoted") {
      if (isEnter(k)) return used(suggest.run(suggest.step.quote));
      if (k.name === "escape") return used(suggest.reset());
    }
    if (k.name === "tab") return used(setPane(pane === "facts" ? "history" : "facts"));
    if (pane === "history") {
      if (isDown(k)) return used(setHsel(Math.min(events.length - 1, hcur + 1)));
      if (isUp(k)) return used(setHsel(Math.max(0, hcur - 1)));
      const e = events[hcur];
      if (e && (isEnter(k) || k.sequence === "u")) {
        if (e.undoable) toggleEvent(e.seq, Boolean(e.undone));
        else app.toast("That one can't be undone from here");
        return true;
      }
    } else {
      if (isDown(k)) return used(setSel(Math.min(rows.length - 1, cur + 1)));
      if (isUp(k)) return used(setSel(Math.max(0, cur - 1)));
      if (isEnter(k)) return used(edit(row));
      if (k.sequence === "y") return used(right(row));
      if (k.sequence === "n") return used(wrong(row));
    }
    switch (k.sequence) {
      case "Y":
        return used(allRight());
      case "s":
        return used(suggestWith(ai.preferred));
      case "m":
        return used(app.move([t]));
      case "x":
        return used(notHere());
      case "+":
        return used(spot());
      case "t":
        return used(edit({ r: "tags" }));
      case "#":
        return used(app.copy(t.id));
      case "o":
        return used(app.copy(app.webUrl(`/things/${t.id}`), "the link"));
      case "h":
        return used(app.back());
    }
    return false;
  });

  // ---------------------------------------------------------------- layout
  const twoCols = size === "wide" || size === "medium";
  const leftW = twoCols ? Math.floor(w * (size === "wide" ? 0.6 : 0.58)) : w;
  const rightW = twoCols ? w - leftW - 1 : w;
  const url = typeof t.data.url === "string" ? t.data.url : null;
  const head: Seg[] = [
    { t: t.name, b: true },
    { t: "   " },
    stateSeg(th, t, true),
    { t: `   ${t.kind} · ${t.id}`, fg: th.dim },
  ];
  if (!twoCols && d.assets.length) head.push({ t: ` · ▣ ${d.assets.length}`, fg: th.dim });
  const headerH = 2 + (url ? 1 : 0);
  const bodyH = h - headerH - 1;
  const showFacts = twoCols || pane === "facts";
  const showHistory = twoCols || pane === "history";

  return (
    <box flexDirection="column" width={w} height={h}>
      <L w={w} segs={head} />
      {url && (
        <L
          w={w}
          segs={[
            { t: "↗ ", fg: th.link },
            { t: cut(url, w - 4), fg: th.link, u: true, href: url },
          ]}
        />
      )}
      <L
        w={w}
        segs={
          !hasWhere(t)
            ? [{ t: t.kind === "tag" ? `tag · ${plural(d.tagged.length, "thing")}` : t.kind, fg: th.dim }]
            : t.gaps.includes("where")
              ? [
                  { t: "▲ Not placed yet  ", fg: th.warn },
                  kc(th, "m"),
                  { t: " put it somewhere", fg: th.dim },
                ]
              : [
                  { t: "in ", fg: th.dim },
                  whereText(t, w - 14),
                  t.parentId && !t.position ? { t: "  + spot", fg: th.dim } : null,
                ]
        }
      />
      <box height={1} />
      <box flexDirection="row" gap={1} height={bodyH}>
        {showFacts && (
          <Facts
            d={d}
            items={items}
            rows={rows}
            cur={cur}
            w={leftW}
            h={bodyH}
            focused={pane === "facts"}
            isGuess={isGuess}
            aiLine={stepText(suggest.step) || (ai.preferred ? `AI ${ai.preferred.label}  ` : "")}
          />
        )}
        {showHistory && (
          <box flexDirection="column" width={rightW} height={bodyH}>
            {size === "wide" && d.assets.length > 0 && (
              <Pane title={`Pictures · ${d.assets.length}`} height={Math.min(6, 2 + d.assets.length + 1)}>
                {d.assets.slice(0, 3).map((a) => (
                  <L
                    key={a.id}
                    w={rightW - 4}
                    segs={[
                      {
                        t: a.id === d.coverId || (!d.coverId && a.id === t.cover?.id) ? "★ " : "  ",
                        fg: th.warn,
                      },
                      { t: fit(ROLE_LABEL[a.role], 12) },
                      {
                        t: cut(a.label ?? a.file, rightW - 20),
                        fg: th.dim,
                        href: app.webUrl(`/media/${a.file}`),
                      },
                    ]}
                  />
                ))}
                <L w={rightW - 4} segs={[kc(th, "o"), { t: " copy the web link to see them", fg: th.dim }]} />
              </Pane>
            )}
            <History d={d} w={rightW} cur={hcur} focused={pane === "history"} onToggle={toggleEvent} />
          </box>
        )}
      </box>
    </box>
  );
}

function Facts({
  d,
  items,
  rows,
  cur,
  w,
  h,
  focused,
  isGuess,
  aiLine,
}: {
  d: ThingDetail;
  items: Item[];
  rows: { it: Item; i: number }[];
  cur: number;
  w: number;
  h: number;
  focused: boolean;
  isGuess: (key: string | null) => boolean;
  aiLine: string;
}) {
  const th = useTheme();
  const t = d.thing;
  const iw = w - 4;
  const lw = Math.min(16, Math.floor(iw * 0.25));
  const sw = 9;
  const aw = 7;
  const vw = Math.max(8, iw - lw - sw - aw - 3);
  const selIndex = rows[cur]?.i ?? 0;
  const { start, items: vis } = windowOf(items, selIndex, h - 4);

  function src(key: string): Seg {
    const m = t.meta[key];
    if (!m) return { t: "" };
    const s = m.source === "app" ? "app" : m.source;
    return {
      t: fit(`${s}${m.confirmed ? " ✓" : ""}`, sw),
      fg: m.source === "ai" && !m.confirmed ? th.ai : th.dim,
    };
  }
  function line(it: Item, sel: boolean, key: number) {
    if (it.r === "rule") return <Rule key={key} w={iw} label={it.label} />;
    const cells = (labelText: string, value: Seg, source: Seg, guess: boolean) => (
      <L
        key={key}
        w={iw}
        sel={sel}
        segs={[
          { t: fit(labelText, lw), fg: th.dim },
          " ",
          { ...value, t: fit(value.t, vw) },
          " ",
          { ...source, t: fit(source.t, sw) },
          " ",
          guess ? kcAi(th, "y") : null,
          guess ? " " : null,
          guess ? kc(th, "n") : null,
        ]}
      />
    );
    if (it.r === "name")
      return cells(
        "Name",
        isGuess("name") ? { t: `✦ ${t.name}`, fg: th.ai } : { t: t.name, b: true },
        src("name"),
        isGuess("name"),
      );
    if (it.r === "kind")
      return cells(
        "Kind",
        isGuess("kind") ? { t: `✦ ${t.kind}`, fg: th.ai } : { t: t.kind },
        src("kind"),
        isGuess("kind"),
      );
    if (it.r === "tags") {
      const ai = t.tags.filter((g) => g.source === "ai");
      const text = t.tags.length
        ? t.tags.map((g) => (g.source === "ai" ? `✦${g.name}` : g.name)).join(" · ")
        : "none";
      return cells(
        "Tags",
        { t: text, fg: ai.length ? th.ai : t.tags.length ? th.fg : th.dim },
        ai.length ? { t: "ai", fg: th.ai } : { t: "" },
        ai.length > 0,
      );
    }
    if (it.r === "field") {
      const v = valueText(t.data[it.key]);
      const unit = it.f?.unit && v ? ` ${it.f.unit}` : "";
      const value: Seg = !v
        ? it.f?.wanted
          ? { t: "▲ wanted", fg: th.warn }
          : { t: "—", fg: th.dim }
        : isGuess(it.key)
          ? { t: `✦ ${v}${unit}`, fg: th.ai }
          : it.f?.type === "url" || it.key === "url"
            ? { t: v, fg: th.link, u: true, href: v }
            : { t: `${v}${unit}` };
      return cells(it.f?.label ?? label(it.key), value, src(it.key), isGuess(it.key));
    }
    if (it.r === "link")
      return cells(
        it.rel.label,
        { t: `${it.rel.other.name}  ${it.rel.other.id}` },
        { t: it.rel.other.kind, fg: th.dim },
        false,
      );
    return cells(it.t.id, { t: it.t.name }, { t: cut(it.why, sw), fg: th.dim }, false);
  }
  return (
    <Pane title="Facts" focused={focused} width={w} height={h}>
      <L
        w={iw}
        segs={[
          { t: aiLine, fg: aiLine.startsWith("AI:") ? th.bad : th.ai },
          aiLine.startsWith("AI ") ? kc(th, "s") : null,
          aiLine.startsWith("AI ") ? { t: " suggest", fg: th.dim } : null,
        ]}
      />
      <L
        w={iw}
        segs={[
          { t: fit("FIELD", lw + 1), fg: th.dim },
          { t: fit("VALUE", vw + 1), fg: th.dim },
          { t: "SOURCE", fg: th.dim },
        ]}
      />
      {vis.map((it, i) => line(it, focused && start + i === selIndex, start + i))}
    </Pane>
  );
}

function History({
  d,
  w,
  cur,
  focused,
  onToggle,
}: {
  d: ThingDetail;
  w: number;
  cur: number;
  focused: boolean;
  onToggle: (seq: number, undone: boolean) => void;
}) {
  const th = useTheme();
  const iw = w - 4;
  const { start, items } = windowOf(d.events, cur, 30);
  return (
    <Pane title={`History · ${d.events.length}`} focused={focused} flexGrow={1}>
      {items.map((e, i) => {
        const sel = focused && start + i === cur;
        const text = eventLabel(e) + (e.undone ? " (undone)" : "");
        return (
          <L
            key={e.seq}
            w={iw}
            sel={sel}
            onClick={() => e.undoable && onToggle(e.seq, Boolean(e.undone))}
            segs={[
              { t: fit(ago(e.at), 5), fg: th.dim },
              { t: fit(cut(e.actor, 8), 9), fg: e.actor === "ai" ? th.ai : th.dim },
              { t: fit(text, iw - 5 - 9 - 4), fg: e.undone ? th.dim : e.actor === "ai" ? th.ai : th.fg },
              e.undoable ? kc(th, e.undone ? "↻" : "u") : null,
            ]}
          />
        );
      })}
      {!d.events.length && <Empty w={iw} text="No history yet" />}
    </Pane>
  );
}
