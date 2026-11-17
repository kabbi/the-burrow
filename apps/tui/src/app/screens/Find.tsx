import { useState } from "react";
import { eventLabel, post, type ThingView } from "../../api.ts";
import { ago, cut, fit, plural, valueText, whereText, width } from "../../text.ts";
import { useEvents, useOverview, useSearch, useThing } from "../data.ts";
import { isDown, isEnter, isUp, printable, useKeys, useLine, used } from "../keys.tsx";
import { LineView } from "../modals.tsx";
import { useApp, useScreen, type Command } from "../state.tsx";
import { useTheme, type Theme } from "../theme.ts";
import { Empty, kc, L, Pane, Rule, stateSeg, uncheckedAi, windowOf, type Seg } from "../ui.tsx";

// Find (the home screen): search first, results, a preview of the selected thing.

/** The name with the words you typed underlined. */
export function marked(th: Theme, name: string, q: string, w: number): Seg[] {
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((x) => x.length >= 2);
  const text = cut(name, w);
  if (!words.length) return [{ t: text }];
  const lower = text.toLowerCase();
  const hit = Array.from({ length: text.length }, () => false);
  for (const word of words)
    for (let i = lower.indexOf(word); i >= 0; i = lower.indexOf(word, i + 1))
      for (let j = i; j < i + word.length; j++) hit[j] = true;
  const out: Seg[] = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && hit[j] === hit[i]) j++;
    out.push(hit[i] ? { t: text.slice(i, j), u: true, b: true } : { t: text.slice(i, j) });
    i = j;
  }
  return out.length ? out : [{ t: text, fg: th.fg }];
}

export function ThingLine({
  t,
  w,
  sel,
  q = "",
  onClick,
}: {
  t: ThingView;
  w: number;
  sel: boolean;
  q?: string;
  onClick?: () => void;
}) {
  const th = useTheme();
  const kindW = w >= 72 ? 12 : 0;
  const rest = w - 8 - kindW - 3;
  const nameW = Math.max(10, Math.floor(rest * 0.5));
  const whereW = Math.max(0, rest - nameW - 1);
  const ai = uncheckedAi(t).length > 0;
  const nameSegs = marked(th, t.name, q, ai ? nameW - 2 : nameW);
  if (ai) nameSegs.push({ t: " ✦", fg: th.ai });
  const nameUsed = nameSegs.reduce((n, x) => n + width(x.t), 0);
  const gap = t.gaps.includes("where");
  return (
    <L
      w={w}
      sel={sel}
      {...(onClick ? { onClick } : {})}
      segs={[
        { t: fit(t.id, 8), fg: th.dim },
        ...nameSegs,
        " ".repeat(Math.max(0, nameW - nameUsed) + 1),
        kindW ? { t: fit(t.kind, kindW), fg: th.dim } : null,
        gap ? { t: fit("▲ not placed yet", whereW), fg: th.warn } : { t: fit(whereText(t, whereW), whereW) },
        " ",
        stateSeg(th, t),
      ]}
    />
  );
}

export function Preview({ id, w, title = "Preview" }: { id: string | null; w: number; title?: string }) {
  const th = useTheme();
  const { data } = useThing(id);
  const iw = w - 4;
  if (!id)
    return (
      <Pane title={title} width={w}>
        {<Empty w={iw} text="Nothing selected" />}
      </Pane>
    );
  if (!data)
    return (
      <Pane title={`${title} · ${id}`} width={w}>
        {<Empty w={iw} text="…" />}
      </Pane>
    );
  const t = data.thing;
  const facts = data.fields.filter((f) => valueText(t.data[f.key])).slice(0, 4);
  const ai = uncheckedAi(t);
  return (
    <Pane title={`${title} · ${t.id}`} width={w}>
      <L w={iw} segs={[{ t: t.name, b: true }]} />
      <L
        w={iw}
        segs={[
          stateSeg(th, t, true),
          { t: ` · ${t.kind}`, fg: th.dim },
          data.children.length
            ? { t: ` · ${plural(data.children.length, "thing")} inside`, fg: th.dim }
            : null,
          data.assets.length ? { t: ` · ▣ ${plural(data.assets.length, "picture")}`, fg: th.dim } : null,
        ]}
      />
      {(t.path.length > 0 || t.gaps.includes("where") || t.roams) && (
        <L
          w={iw}
          segs={[
            t.gaps.includes("where")
              ? { t: "▲ Not placed yet", fg: th.warn }
              : { t: whereText(t, iw), fg: th.dim },
          ]}
        />
      )}
      <L w={iw} segs={[]} />
      {facts.map((f) => (
        <L
          key={f.key}
          w={iw}
          segs={[
            { t: fit(f.label, 14), fg: th.dim },
            t.meta[f.key]?.source === "ai" && !t.meta[f.key]?.confirmed
              ? { t: `✦ ${valueText(t.data[f.key])}`, fg: th.ai }
              : valueText(t.data[f.key]),
          ]}
        />
      ))}
      {data.children.length > 0 && (
        <>
          <L w={iw} segs={[{ t: "Inside", fg: th.dim }]} />
          {data.children.slice(0, 5).map((c) => (
            <L key={c.id} w={iw} segs={[{ t: `  ${fit(c.id, 8)}`, fg: th.dim }, c.name]} />
          ))}
          {data.children.length > 5 && (
            <L w={iw} segs={[{ t: `  … ${data.children.length - 5} more`, fg: th.dim }]} />
          )}
        </>
      )}
      {t.tags.length > 0 && (
        <L
          w={iw}
          segs={[
            { t: "Tags  ", fg: th.dim },
            ...t.tags.flatMap((g, i) => [
              i ? { t: " · ", fg: th.dim } : null,
              g.source === "ai" ? { t: `✦ ${g.name}`, fg: th.ai } : { t: g.name },
            ]),
          ]}
        />
      )}
      {ai.length > 0 && (
        <L w={iw} segs={[{ t: `✦ ${plural(ai.length, "AI guess", "AI guesses")} to check`, fg: th.ai }]} />
      )}
      <box flexGrow={1} />
      <L
        w={iw}
        segs={[
          kc(th, "⏎"),
          { t: " open  ", fg: th.dim },
          kc(th, "m"),
          { t: " move  ", fg: th.dim },
          kc(th, "x"),
          { t: t.status === "missing" ? " found it" : " not here", fg: th.dim },
        ]}
      />
    </Pane>
  );
}

export function FindScreen() {
  const app = useApp();
  const th = useTheme();
  const { w, h, size } = app.area;
  const line = useLine();
  const [typing, setTyping] = useState(true);
  const [sel, setSel] = useState(0);
  const q = line.value.trim();
  const search = useSearch(q);
  const { data: ov } = useOverview();
  const { data: events = [] } = useEvents(12);
  const results = q ? (search.data?.hits.map((x) => x.thing) ?? []) : (ov?.recentlyAdded ?? []);
  const cur = Math.min(sel, Math.max(0, results.length - 1));
  const selected = results[cur] ?? null;

  const open = (t: ThingView | null) => t && app.go({ s: "thing", id: t.id });
  const notHere = (t: ThingView) =>
    void app.act(
      () => post(`/things/${t.id}/status`, { status: t.status === "missing" ? "ok" : "missing" }),
      t.status === "missing" ? `Found ${t.name}` : `${t.name}: not here (missing)`,
    );

  const commands: Command[] = selected
    ? [
        { section: "Selected", title: `Open ${selected.name}`, key: "⏎", run: () => open(selected) },
        { section: "Selected", title: `Move ${selected.name}`, key: "m", run: () => app.move([selected]) },
        {
          section: "Selected",
          title: selected.status === "missing" ? "Found it" : "It's not here",
          key: "x",
          run: () => notHere(selected),
        },
        { section: "Selected", title: `Copy ID ${selected.id}`, key: "y", run: () => app.copy(selected.id) },
      ]
    : [];
  useScreen({
    commands,
    hints: typing
      ? [
          ["↑↓", "pick"],
          ["⏎", "open"],
          ["tab", "keys"],
          ["esc", q ? "clear" : "keys"],
        ]
      : [
          ["↑↓", "move"],
          ["⏎", "open"],
          ["/", "search"],
          ["a", "add"],
          ["m", "move"],
          ["x", "not here"],
          ["y", "copy ID"],
        ],
  });

  const step = (d: number) => setSel(Math.max(0, Math.min(results.length - 1, cur + d)));
  useKeys(
    (k) => {
      if (k.name === "down" || (k.ctrl && k.name === "n")) return used(step(1));
      if (k.name === "up" || (k.ctrl && k.name === "p")) return used(step(-1));
      if (k.name === "pagedown") return used(step(10));
      if (k.name === "pageup") return used(step(-10));
      if (isEnter(k)) return used(open(selected));
      if (typing) {
        if (k.name === "tab") return used(setTyping(false));
        if (k.name === "escape") {
          if (line.value) line.set("");
          else setTyping(false);
          return true;
        }
        if (line.edit(k)) {
          setSel(0);
          return true;
        }
        return false;
      }
      if (isDown(k)) return used(step(1));
      if (isUp(k)) return used(step(-1));
      if (k.sequence === "/" || k.name === "tab") return used(setTyping(true));
      if (k.sequence === "a") return used(app.go({ s: "add" }));
      if (selected && k.sequence === "m") return used(app.move([selected]));
      if (selected && k.sequence === "x") return used(notHere(selected));
      if (selected && k.sequence === "y") return used(app.copy(selected.id));
      if (selected && (k.sequence === "l" || k.name === "right")) return used(open(selected));
      if (k.sequence === "g") return used(setSel(0));
      if (k.sequence === "G") return used(setSel(results.length - 1));
      // Typing a letter that isn't a key starts a new search.
      const ch = printable(k);
      if (ch && /\p{L}/u.test(ch) && !"uq".includes(ch)) {
        setTyping(true);
        line.set(ch);
        setSel(0);
        return true;
      }
      return false;
    },
    { paste: (t) => (setTyping(true), line.insert(t), setSel(0), true) },
  );

  const showPreview = size === "wide" || size === "medium";
  const previewW = showPreview ? Math.max(36, Math.floor(w * (size === "wide" ? 0.38 : 0.42))) : 0;
  const listW = w - (showPreview ? previewW + 1 : 0);
  const iw = listW - 4;
  const bodyH = h - 3;
  const missing = ov?.missing ?? [];
  const recent = events.filter((e) => !e.undoOf && !e.undone && e.thing).slice(0, 5);
  // Room for the sections under an empty search.
  const extra = q
    ? 0
    : Math.min(
        2 + Math.max(1, missing.length) + 2 + recent.length,
        Math.max(0, bodyH - 2 - 1 - results.length),
      );
  const rows = Math.max(1, bodyH - 2 - 1 - (q ? 0 : extra) - (size === "narrow" && !q ? 0 : 0));
  const win = windowOf(results, cur, rows);
  const count = q
    ? search.isFetching && !search.data
      ? "searching…"
      : plural(results.length, "match", "matches")
    : "";

  return (
    <box flexDirection="column" width={w} height={h}>
      <Pane title="Where's my…" focused={typing} height={3}>
        <box flexDirection="row">
          <LineView
            line={line}
            w={iw - width(count) - 1 + (showPreview ? previewW + 1 : 0)}
            active={typing}
            placeholder="type a name, a place, a tag or b42"
          />
          <L segs={[{ t: ` ${count}`, fg: th.dim }]} />
        </box>
      </Pane>
      <box flexDirection="row" height={bodyH} gap={1}>
        <Pane
          title={q ? "Results" : "Recently added"}
          focused={!typing}
          width={listW}
          onWheel={(d) => step(d)}
        >
          <L
            w={iw}
            segs={[
              { t: fit("ID", 8), fg: th.dim },
              { t: "NAME · WHERE", fg: th.dim },
            ]}
          />
          {win.items.map((t, i) => (
            <ThingLine
              key={t.id}
              t={t}
              w={iw}
              q={q}
              sel={win.start + i === cur}
              onClick={() => (win.start + i === cur ? open(t) : setSel(win.start + i))}
            />
          ))}
          {q && !results.length && !search.isFetching && (
            <Empty w={iw} text={`Nothing matches "${q}". a adds it.`} />
          )}
          {!q && extra > 0 && (
            <>
              <box flexGrow={1} />
              <Rule w={iw} label="Missing · last seen" />
              {missing.length ? (
                missing
                  .slice(0, 3)
                  .map((t) => <ThingLine key={t.id} t={t} w={iw} sel={false} onClick={() => open(t)} />)
              ) : (
                <L
                  w={iw}
                  segs={[
                    { t: "✓ ", fg: th.ok },
                    { t: "nothing is missing", fg: th.dim },
                  ]}
                />
              )}
              {recent.length > 0 && <Rule w={iw} label="Recently changed" />}
              {recent.map((e) => (
                <L
                  key={e.seq}
                  w={iw}
                  segs={[
                    { t: fit(ago(e.at), 5), fg: th.dim },
                    e.actor === "ai" ? { t: "✦ ", fg: th.ai } : "",
                    {
                      t: fit(
                        `${e.thing!.name} · ${eventLabel(e, { to: e.thing!.to, from: e.thing!.from })}`,
                        iw - 5 - 12,
                      ),
                    },
                    { t: fit(e.actor, 10, true), fg: e.actor === "ai" ? th.ai : th.dim },
                  ]}
                  onClick={() => app.go({ s: "thing", id: e.thing!.id })}
                />
              ))}
            </>
          )}
        </Pane>
        {showPreview && <Preview id={selected?.id ?? null} w={previewW} />}
      </box>
    </box>
  );
}
