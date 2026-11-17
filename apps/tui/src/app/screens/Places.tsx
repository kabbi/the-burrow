import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { get, patch, post, type PlaceNode, type ThingView } from "../../api.ts";
import { cut, fit, plural } from "../../text.ts";
import { usePlaceTree, useSchema } from "../data.ts";
import { isDown, isEnter, isUp, useKeys, used } from "../keys.tsx";
import { useApp, useScreen, type Command, type Movable } from "../state.tsx";
import { useTheme } from "../theme.ts";
import { Empty, L, Pane, windowOf } from "../ui.tsx";
import { Preview } from "./Find.tsx";

// Places as Finder-style columns: rooms, then what's inside, with direct and nested counts.
// Everything without a place sits in one group, so you can mark several and move them together.

const ROAMING = "~roaming";
const UNPLACED = "~unplaced";

interface Item {
  id: string;
  name: string;
  isPlace: boolean;
  /** Things directly inside / at any depth (places only). */
  items?: number;
  total?: number;
  thing?: ThingView;
  virtual?: boolean;
  note?: string;
}

function placeItem(p: PlaceNode): Item {
  return { id: p.id, name: p.name, isPlace: true, items: p.items, total: p.total };
}

export function PlacesScreen() {
  const app = useApp();
  const th = useTheme();
  const { w, h, size } = app.area;
  const { data: tree } = usePlaceTree();
  const { data: schema } = useSchema();
  const nodes = new Map((tree?.places ?? []).map((p) => [p.id, p]));
  const [trail, setTrail] = useState<string[]>([]);
  const [col, setCol] = useState(0);
  const [marks, setMarks] = useState<Map<string, Movable>>(new Map());
  const [carrying, setCarrying] = useState<Movable[] | null>(null);

  // Column 0: the rooms (top-level places), then the two nowheres.
  const roots: Item[] = [
    ...(tree?.places ?? [])
      .filter((p) => !p.parentId)
      .toSorted((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .map(placeItem),
    {
      id: ROAMING,
      name: "No fixed place",
      isPlace: true,
      items: tree?.roaming ?? 0,
      total: tree?.roaming ?? 0,
      virtual: true,
    },
    {
      id: UNPLACED,
      name: "▲ No place yet",
      isPlace: true,
      items: tree?.unplaced ?? 0,
      total: tree?.unplaced ?? 0,
      virtual: true,
    },
  ];
  const { data: unplaced = [] } = useQuery({
    queryKey: ["unplaced"],
    queryFn: async () =>
      (await get<{ things: ThingView[] }>("/needs-details")).things.filter((t) => t.gaps.includes("where")),
    enabled: trail[0] === UNPLACED,
  });
  const parents = trail.filter((id) => id === ROAMING || id === UNPLACED || nodes.has(id));
  const childQueries = useQueries({
    queries: parents.map((id) => ({
      queryKey: ["children", id],
      queryFn: async () =>
        (
          await get<{ things: ThingView[] }>(
            id === ROAMING
              ? "/things?roams=1&order=name&limit=500"
              : `/things?parent=${id}&order=name&limit=500`,
          )
        ).things,
      // The unplaced group comes from /needs-details (above).
      enabled: id !== UNPLACED,
    })),
  });
  const columns: Item[][] = [roots];
  parents.forEach((pid, i) => {
    const things = (pid === UNPLACED ? unplaced : (childQueries[i]?.data ?? [])).map((t): Item => {
      const n = nodes.get(t.id);
      return n
        ? { ...placeItem(n), thing: t }
        : { id: t.id, name: t.name, isPlace: false, thing: t, ...(t.position ? { note: t.position } : {}) };
    });
    columns.push(things.toSorted((a, b) => Number(b.isPlace) - Number(a.isPlace)));
  });

  const selIndex = (c: number) => {
    const list = columns[c] ?? [];
    const i = list.findIndex((x) => x.id === trail[c]);
    return i < 0 ? 0 : i;
  };
  const current = columns[col]?.[selIndex(col)] ?? null;
  const ownerOf = (c: number) => (c === 0 ? null : (trail[c - 1] ?? null));

  function select(c: number, id: string) {
    setTrail((t) => [...t.slice(0, c), id]);
  }
  function step(d: number) {
    const list = columns[col] ?? [];
    const next = list[Math.max(0, Math.min(list.length - 1, selIndex(col) + d))];
    if (next) select(col, next.id);
  }
  function into() {
    if (!current) return;
    if (!current.isPlace) return current.thing && app.go({ s: "thing", id: current.id });
    select(col, current.id);
    setCol(col + 1);
  }
  const out = () => col > 0 && setCol(col - 1);
  const asMovable = (x: Item): Movable => ({ id: x.id, name: x.name });

  function toggleMark() {
    if (!current || current.virtual) return;
    setMarks((m) => {
      const n = new Map(m);
      if (n.has(current.id)) n.delete(current.id);
      else n.set(current.id, asMovable(current));
      return n;
    });
    step(1);
  }
  function pickUp() {
    const load = marks.size ? [...marks.values()] : current && !current.virtual ? [asMovable(current)] : [];
    if (!load.length) return;
    setCarrying(load);
  }
  function drop() {
    if (!carrying) return;
    // Into the highlighted place; on a thing, into the place whose column this is.
    const target = current?.isPlace && !current.virtual ? current : null;
    const owner = ownerOf(col);
    const to = target?.id ?? (owner && !owner.startsWith("~") ? owner : null);
    if (current?.id === ROAMING || owner === ROAMING)
      app.moveTo(carrying, { to: null, roams: true, label: "No fixed place" });
    else if (current?.id === UNPLACED || owner === UNPLACED)
      app.moveTo(carrying, { to: null, roams: false, label: "not placed yet" });
    else if (to) app.moveTo(carrying, { to, roams: false, label: target?.name ?? nodes.get(to)?.name ?? to });
    else return app.toast("Walk to a place first");
    setCarrying(null);
    setMarks(new Map());
  }
  function newPlace() {
    const owner = col === 0 ? null : ownerOf(col);
    if (owner?.startsWith("~")) return app.toast("New places go in a room, or at the top");
    const placeKinds = (schema?.kinds ?? []).filter((k) => k.isPlace).map((k) => k.id);
    const kind = owner
      ? placeKinds.includes("container")
        ? "container"
        : placeKinds[0]
      : placeKinds.includes("room")
        ? "room"
        : placeKinds[0];
    app.prompt({
      title: owner ? `New place in ${nodes.get(owner)?.name ?? owner}` : "New room",
      hint: `kind: ${kind ?? "?"}`,
      onSubmit: (v) =>
        v.trim() &&
        void app.act(() => post("/things", { name: v.trim(), kind, parentId: owner }), `Added ${v.trim()}`),
    });
  }
  function rename() {
    if (!current || current.virtual) return;
    app.prompt({
      title: `Rename ${current.name}`,
      initial: current.name,
      onSubmit: (v) =>
        v.trim() &&
        v.trim() !== current.name &&
        void app.act(() => patch(`/things/${current.id}`, { name: v.trim() }), `Renamed to ${v.trim()}`),
    });
  }

  const commands: Command[] = [
    { section: "Places", title: "Mark / unmark", key: "space", run: toggleMark },
    {
      section: "Places",
      title: carrying ? "Drop here" : "Pick up to move",
      key: carrying ? "⏎" : "m",
      run: carrying ? drop : pickUp,
    },
    {
      section: "Places",
      title: "Move with the place picker",
      key: "M",
      run: () =>
        current && !current.virtual && app.move(marks.size ? [...marks.values()] : [asMovable(current)]),
    },
    { section: "Places", title: "New place here", key: "n", run: newPlace },
    { section: "Places", title: "Rename", key: "r", run: rename },
    { section: "Places", title: "Clear marks", run: () => setMarks(new Map()) },
  ];
  useScreen({
    commands,
    hints: carrying
      ? [
          ["↑↓←→", "walk"],
          ["⏎", "drop here"],
          ["esc", "cancel"],
        ]
      : [
          ["←→", "out / in"],
          ["↑↓", "move"],
          ["⏎", "open"],
          ["space", "mark"],
          ["m", "pick up"],
          ["n", "new place"],
          ["r", "rename"],
        ],
  });

  useKeys((k) => {
    if (isDown(k)) return used(step(1));
    if (isUp(k)) return used(step(-1));
    if (k.name === "pagedown") return used(step(10));
    if (k.name === "pageup") return used(step(-10));
    if (k.name === "right" || k.sequence === "l") return used(current?.isPlace ? into() : undefined);
    if (k.name === "left" || k.sequence === "h") return used(out());
    if (isEnter(k)) return used(carrying ? drop() : into());
    if (k.name === "escape" && (carrying || marks.size)) {
      setCarrying(null);
      if (!carrying) setMarks(new Map());
      return true;
    }
    if (k.name === "space" || k.sequence === " ") return used(toggleMark());
    if (k.sequence === "m") return used(pickUp());
    if (k.sequence === "M" && current && !current.virtual)
      return used(app.move(marks.size ? [...marks.values()] : [asMovable(current)]));
    if (k.sequence === "n") return used(newPlace());
    if (k.sequence === "r") return used(rename());
    if (k.sequence === "o" && current && !current.virtual)
      return used(app.go({ s: "thing", id: current.id }));
    return false;
  });

  // ---------------------------------------------------------------- layout
  const showPreview = size === "wide" || size === "medium";
  const previewW = showPreview ? Math.max(34, Math.floor(w * 0.3)) : 0;
  const avail = w - (showPreview ? previewW + 1 : 0);
  const colW = size === "tiny" ? avail : Math.max(24, Math.min(36, Math.floor(avail / 3) - 1));
  const fits = Math.max(1, Math.floor((avail + 1) / (colW + 1)));
  const last = Math.min(columns.length - 1, col + 1);
  const first = Math.max(0, last - fits + 1, size === "tiny" ? col : 0);
  const visible = columns
    .slice(first, Math.min(last, first + fits - 1) + 1)
    .map((items, i) => ({ items, c: first + i }));
  const crumbs = trail
    .slice(0, col + 1)
    .map((id) =>
      id === ROAMING
        ? "No fixed place"
        : id === UNPLACED
          ? "No place yet"
          : (nodes.get(id)?.name ?? columns.flat().find((x) => x.id === id)?.name ?? id),
    );
  const bodyH = h - 2;

  return (
    <box flexDirection="column" width={w} height={h}>
      <L
        w={w}
        segs={[
          { t: "Places", fg: th.dim },
          ...crumbs.flatMap((c, i) => [
            { t: " › ", fg: th.dim },
            { t: c, b: i === crumbs.length - 1 },
          ]),
          { t: `   ${plural(tree?.places.length ?? 0, "place")}`, fg: th.dim },
        ]}
      />
      <box flexDirection="row" gap={1} height={bodyH}>
        {visible.map(({ items, c }) => {
          const owner = ownerOf(c);
          const title =
            c === 0
              ? `Rooms · ${roots.length - 2}`
              : owner === ROAMING
                ? "No fixed place"
                : owner === UNPLACED
                  ? `No place yet · ${items.length}`
                  : (nodes.get(owner ?? "")?.name ?? "");
          const sel = selIndex(c);
          const win = windowOf(items, sel, bodyH - 2);
          const iw = colW - 4;
          return (
            <Pane
              key={c}
              title={cut(title, colW - 6)}
              focused={c === col}
              width={colW}
              onWheel={(d) => (setCol(c), step(d))}
            >
              {win.items.map((x, i) => {
                const idx = win.start + i;
                const onTrail = trail[c] === x.id;
                const marked = marks.has(x.id);
                const count = x.isPlace
                  ? x.total === x.items
                    ? `${x.total ?? 0}`
                    : `${x.items ?? 0} (${x.total ?? 0})`
                  : "";
                const isSel = c === col && idx === sel;
                return (
                  <L
                    key={x.id}
                    w={iw}
                    sel={isSel}
                    {...(!isSel && onTrail ? { bg: th.key } : {})}
                    onClick={() => {
                      setCol(c);
                      if (isSel) into();
                      else select(c, x.id);
                    }}
                    segs={[
                      { t: marked ? "◆ " : x.isPlace ? "" : "· ", fg: marked ? th.main : th.dim },
                      {
                        t: fit(
                          x.name + (x.note ? ` · ${x.note}` : ""),
                          iw - (marked || !x.isPlace ? 2 : 0) - count.length - 3,
                        ),
                        b: onTrail,
                        fg: x.virtual && x.id === UNPLACED ? th.warn : undefined,
                      },
                      {
                        t: ` ${count}`,
                        fg: x.isPlace && !x.total ? th.dim : x.id === UNPLACED ? th.warn : th.fg,
                      },
                      { t: x.isPlace ? " ›" : "", fg: th.dim },
                    ]}
                  />
                );
              })}
              {!items.length && <Empty w={iw} text={c === 0 ? "No places yet. n adds a room." : "Empty"} />}
            </Pane>
          );
        })}
        {showPreview && (
          <Preview
            id={current && !current.virtual ? current.id : null}
            w={Math.max(previewW, w - visible.length * (colW + 1))}
          />
        )}
      </box>
      <L
        w={w}
        segs={
          carrying
            ? [
                {
                  t: `Carrying ${carrying.length === 1 ? carrying[0]!.name : plural(carrying.length, "thing")}: walk to a place, ⏎ drop here, esc puts it back. One undo.`,
                  fg: th.main,
                  b: true,
                },
              ]
            : [
                {
                  t: "Move: space marks several · m picks up · walk to a place · ⏎ drops. A box moves with everything in it.",
                  fg: th.dim,
                },
                { t: marks.size ? `   ${marks.size} marked` : "", fg: th.main },
              ]
        }
      />
    </box>
  );
}
