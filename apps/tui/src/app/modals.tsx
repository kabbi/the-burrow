import { useState, type ReactNode } from "react";
import { asId, type Place } from "../api.ts";
import { cut, fit, foldPath, SEP } from "../text.ts";
import { usePlaces, useSearch } from "./data.ts";
import { isDown, isEnter, isUp, useKeys, useLine, type Line, used } from "./keys.tsx";
import type { Command } from "./state.tsx";
import { useTheme } from "./theme.ts";
import { Hints, kc, L, windowOf, type Seg } from "./ui.tsx";

// Things that sit on top of a screen and take every key until they close.

function Frame({ title, w, h, children }: { title: string; w: number; h: number; children: ReactNode }) {
  const th = useTheme();
  return (
    <box
      position="absolute"
      zIndex={10}
      left={0}
      top={0}
      width="100%"
      height="100%"
      alignItems="center"
      paddingTop={2}
    >
      <box
        border
        borderStyle="rounded"
        borderColor={th.focus}
        title={` ${title} `}
        titleColor={th.fg}
        backgroundColor={th.bg === "transparent" ? th.selFg : th.bg}
        width={w}
        height={h}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        {children}
      </box>
    </box>
  );
}

/** The text field look: "› text█". */
export function LineView({
  line,
  w,
  active = true,
  placeholder,
}: {
  line: Line;
  w: number;
  active?: boolean;
  placeholder?: string;
}) {
  const th = useTheme();
  const before = line.value.slice(0, line.cursor);
  const at = line.value.slice(line.cursor, line.cursor + 1) || " ";
  const after = line.value.slice(line.cursor + 1);
  if (!line.value && placeholder && !active)
    return (
      <L
        w={w}
        segs={[
          { t: "› ", fg: th.dim },
          { t: placeholder, fg: th.dim },
        ]}
      />
    );
  const segs: Seg[] = [
    { t: "› ", fg: active ? th.fg : th.dim, b: true },
    { t: before, b: true },
  ];
  if (active) segs.push({ t: at, bg: th.selBg, fg: th.selFg }, { t: after, b: true });
  else segs.push({ t: line.value.slice(line.cursor), b: true });
  if (!line.value && placeholder && active) segs.push({ t: ` ${placeholder}`, fg: th.dim });
  return <L w={w} segs={segs} />;
}

const matches = (q: string, hay: string) => {
  const h = hay.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => h.includes(word));
};

interface PaletteItem {
  section: string;
  title: string;
  key?: string;
  right?: string;
  run(): void;
}

/** ⌃K: every command with its key; things by name; "b42" jumps to an ID. The palette is the help. */
export function Palette({
  commands,
  w,
  h,
  openThing,
  close,
  context,
}: {
  commands: Command[];
  w: number;
  h: number;
  openThing: (id: string) => void;
  close: () => void;
  context?: string;
}) {
  const th = useTheme();
  const line = useLine();
  const [sel, setSel] = useState(0);
  const q = line.value.trim();
  const commandsOnly = q.startsWith(">");
  const cq = commandsOnly ? q.slice(1) : q;
  const { data } = useSearch(!commandsOnly && q.length >= 2 ? q : "");
  const items: PaletteItem[] = [];
  const id = asId(q);
  if (id && /^b?-?\d+$/i.test(q.replace(/\s/g, "")))
    items.push({ section: "Go to", title: `Open ${id}`, run: () => openThing(id) });
  for (const c of commands)
    if (!cq || matches(cq, `${c.title} ${c.also ?? ""} ${c.section}`))
      items.push({ section: c.section, title: c.title, ...(c.key ? { key: c.key } : {}), run: c.run });
  if (!commandsOnly && q.length >= 2)
    for (const hit of (data?.hits ?? []).slice(0, 6))
      items.push({
        section: "Things",
        title: `${hit.thing.id}  ${hit.thing.name}`,
        right: hit.thing.kind,
        run: () => openThing(hit.thing.id),
      });
  const cur = Math.min(sel, Math.max(0, items.length - 1));
  useKeys(
    (k) => {
      if (k.name === "escape" || (k.ctrl && k.name === "k")) return used(close());
      if (isEnter(k)) {
        const it = items[cur];
        close();
        it?.run();
        return true;
      }
      if (k.name === "up" || (k.ctrl && k.name === "p")) return used(setSel(Math.max(0, cur - 1)));
      if (k.name === "down" || (k.ctrl && k.name === "n") || k.name === "tab")
        return used(setSel(Math.min(items.length - 1, cur + 1)));
      if (line.edit(k)) setSel(0);
      return true;
    },
    { modal: true, paste: (t) => (line.insert(t), true) },
  );
  const iw = w - 4;
  const rows = h - 6;
  // Section headers take a row each; keep it simple: one list with the section on the left.
  const { start, items: vis } = windowOf(items, cur, rows);
  return (
    <Frame title="Commands" w={w} h={h}>
      <LineView line={line} w={iw} placeholder="type a command, a thing, or b42" />
      <L w={iw} segs={[{ t: context ?? "", fg: th.dim }]} />
      {vis.map((it, i) => {
        const selected = start + i === cur;
        const sw = 10;
        const kw = it.key ? it.key.length + 2 : 0;
        const rw = it.right ? it.right.length + 1 : 0;
        return (
          <L
            key={`${it.section}${it.title}`}
            w={iw}
            sel={selected}
            segs={[
              {
                t: fit(start + i === 0 || items[start + i - 1]?.section !== it.section ? it.section : "", sw),
                fg: th.dim,
              },
              { t: fit(it.title, iw - sw - kw - rw - 1), b: selected },
              " ",
              it.right ? { t: fit(it.right, rw), fg: th.dim } : null,
              it.key ? kc(th, it.key) : null,
            ]}
          />
        );
      })}
      {!items.length && <L w={iw} segs={[{ t: "Nothing matches.", fg: th.dim }]} />}
      <box flexGrow={1} />
      <Hints
        w={iw}
        items={[
          ["↑↓", "pick"],
          ["⏎", "run"],
          [">", "commands only"],
          ["b42", "jumps to an ID"],
          ["esc", "close"],
        ]}
      />
    </Frame>
  );
}

export interface MoveTarget {
  to: string | null;
  roams: boolean;
  position?: string;
  label: string;
}

/** Where to? Type to filter the full paths; Tab adds a spot ("shelf 3"). */
export function MovePicker({
  title,
  w,
  h,
  exclude,
  onPick,
  close,
}: {
  title: string;
  w: number;
  h: number;
  /** IDs that can't be the target (the things being moved: no loops). */
  exclude: Set<string>;
  onPick: (t: MoveTarget) => void;
  close: () => void;
}) {
  const th = useTheme();
  const filter = useLine();
  const spot = useLine();
  const [onSpot, setOnSpot] = useState(false);
  const [sel, setSel] = useState(0);
  const { data: places = [] } = usePlaces();
  const q = filter.value.trim();
  const fixed: MoveTarget[] = [
    { to: null, roams: true, label: "No fixed place (it travels)" },
    { to: null, roams: false, label: "Take it out (not placed yet)" },
  ];
  // Moving a box into itself (or into what's inside it) is refused by the server ("no loops").
  const ok = (p: Place) => !exclude.has(p.id);
  const list: MoveTarget[] = [
    ...places
      .filter((p) => ok(p) && (!q || matches(q, `${p.path} ${p.id}`)))
      .map((p) => ({ to: p.id, roams: false, label: p.path })),
    ...(q ? [] : fixed),
  ];
  const cur = Math.min(sel, Math.max(0, list.length - 1));
  useKeys(
    (k) => {
      if (k.name === "escape") return used(close());
      if (k.name === "tab") return used(setOnSpot(!onSpot));
      if (isEnter(k)) {
        const t = list[cur];
        if (!t) return true;
        close();
        onPick({ ...t, ...(spot.value.trim() && t.to ? { position: spot.value.trim() } : {}) });
        return true;
      }
      if (k.name === "up") return used(setSel(Math.max(0, cur - 1)));
      if (k.name === "down") return used(setSel(Math.min(list.length - 1, cur + 1)));
      if ((onSpot ? spot : filter).edit(k) && !onSpot) setSel(0);
      return true;
    },
    { modal: true, paste: (t) => ((onSpot ? spot : filter).insert(t), true) },
  );
  const iw = w - 4;
  const { start, items } = windowOf(list, cur, h - 7);
  return (
    <Frame title={title} w={w} h={h}>
      <LineView line={filter} w={iw} active={!onSpot} placeholder="type to filter places" />
      <L
        w={iw}
        segs={[
          { t: "Spot  ", fg: th.dim },
          ...(onSpot ? [] : [{ t: spot.value || "optional · tab", fg: th.dim }]),
        ]}
      />
      {onSpot && <LineView line={spot} w={iw} placeholder='e.g. "shelf 3"' />}
      {items.map((t, i) => (
        <L
          key={`${t.to}${t.roams}${t.label}`}
          w={iw}
          sel={start + i === cur}
          segs={[
            t.to ? foldPath(t.label.split(SEP), iw - 9) : { t: t.label, fg: th.dim },
            t.to ? { t: `  ${t.to}`, fg: th.dim } : null,
          ]}
        />
      ))}
      {!list.length && <L w={iw} segs={[{ t: `No place matches "${cut(q, 30)}".`, fg: th.dim }]} />}
      <box flexGrow={1} />
      <Hints
        w={iw}
        items={[
          ["↑↓", "pick"],
          ["⏎", "move here"],
          ["tab", "spot"],
          ["esc", "cancel"],
        ]}
      />
    </Frame>
  );
}

export function Prompt({
  title,
  initial,
  hint,
  w,
  onSubmit,
  close,
}: {
  title: string;
  initial?: string;
  hint?: string;
  w: number;
  onSubmit: (v: string) => void;
  close: () => void;
}) {
  const th = useTheme();
  const line = useLine(initial ?? "");
  useKeys(
    (k) => {
      if (k.name === "escape") return used(close());
      if (isEnter(k)) {
        close();
        onSubmit(line.value);
        return true;
      }
      line.edit(k);
      return true;
    },
    { modal: true, paste: (t) => (line.insert(t), true) },
  );
  return (
    <Frame title={title} w={w} h={6}>
      <LineView line={line} w={w - 4} />
      <L w={w - 4} segs={[{ t: hint ?? "", fg: th.dim }]} />
      <Hints
        w={w - 4}
        items={[
          ["⏎", "save"],
          ["esc", "cancel"],
        ]}
      />
    </Frame>
  );
}

export { isDown, isUp };
