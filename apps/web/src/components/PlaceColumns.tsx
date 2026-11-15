import { useEffect, useRef, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { get, type PlaceNode, type ThingView } from "../lib/api.ts";
import { Thumb } from "./ThingCard.tsx";
import { dragSource, useDrop, type Drag } from "./placeDrag.ts";

type Entry = { place: PlaceNode; item?: undefined } | { item: ThingView; place?: undefined };

const entryId = (e: Entry) => (e.place ?? e.item).id;

/**
 * Finder-style columns for deep place hierarchies: each column is what's directly inside the
 * place selected in the column before it. Arrow keys move around, Enter opens the selection.
 * The selection lives in the URL (`?at=<place>&item=<thing>`) so a spot can be linked to.
 */
export function PlaceColumns({
  places,
  byParent,
  placeIds,
  kindName,
  drag,
  filter,
  onPick,
}: {
  places: PlaceNode[];
  byParent: Map<string | null, PlaceNode[]>;
  placeIds: Set<string>;
  kindName: (k: string) => string;
  drag: Drag;
  filter: string;
  onPick: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const byId = new Map(places.map((p) => [p.id, p]));

  // The selected chain of places: room → … → `at`.
  const at = params.get("at");
  const chain: PlaceNode[] = [];
  for (
    let p = at ? byId.get(at) : undefined;
    p && chain.length < 64;
    p = p.parentId ? byId.get(p.parentId) : undefined
  )
    chain.unshift(p);
  const itemId = chain.length ? params.get("item") : null;

  // Things (not places) directly inside each selected place; same cache as the tree's lists.
  const lists = useQueries({
    queries: chain.map((p) => ({
      queryKey: ["things", { parent: p.id }],
      queryFn: () => get<{ things: ThingView[] }>(`/things?parent=${p.id}&order=name&limit=500`),
      enabled: p.items > 0,
    })),
  });

  // columns[0] = rooms; columns[k] = inside chain[k-1].
  const columns: { parent: PlaceNode | null; entries: Entry[]; loading: boolean }[] = [
    { parent: null, entries: (byParent.get(null) ?? []).map((place) => ({ place })), loading: false },
    ...chain.map((p, k) => ({
      parent: p,
      entries: [
        ...(byParent.get(p.id) ?? []).map((place): Entry => ({ place })),
        ...(lists[k]?.data?.things ?? []).filter((t) => !placeIds.has(t.id)).map((item): Entry => ({ item })),
      ],
      loading: p.items > 0 && !lists[k]?.data,
    })),
  ];
  const item = itemId ? columns.at(-1)!.entries.find((e) => e.item?.id === itemId)?.item : undefined;

  const select = (col: number, e: Entry | null) => {
    const next = new URLSearchParams(params);
    const placeAt = e?.place ?? chain[col - 1];
    if (placeAt) next.set("at", placeAt.id);
    else next.delete("at");
    if (e?.item) next.set("item", e.item.id);
    else next.delete("item");
    setParams(next, { replace: true });
  };
  const selectedIn = (col: number) =>
    col < chain.length ? chain[col]!.id : col === chain.length ? itemId : null;

  // Keep the newest column in view, and the selected row inside its column.
  const scroller = useRef<HTMLDivElement>(null);
  const loaded = lists.filter((l) => l.data).length;
  useEffect(() => {
    const s = scroller.current;
    if (!s) return;
    s.scrollTo({ left: s.scrollWidth, behavior: "smooth" });
    // Vertical only: scrollIntoView would also scroll sideways and cancel the jump above.
    for (const el of s.querySelectorAll<HTMLElement>(".pc-entry.sel")) {
      const list = el.parentElement!;
      const top = el.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + el.offsetHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = top + el.offsetHeight - list.clientHeight;
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- re-run when the selection or a list arrives
  }, [at, itemId, loaded]);

  const onKey = (e: KeyboardEvent) => {
    // The column with the keyboard: the one holding the deepest selection.
    const col = itemId ? chain.length : Math.max(chain.length - 1, 0);
    const entries = columns[col]!.entries;
    const i = entries.findIndex((x) => entryId(x) === selectedIn(col));
    const cur = entries[i];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const d = e.key === "ArrowDown" ? 1 : -1;
      const next = entries[i < 0 ? 0 : Math.min(Math.max(i + d, 0), entries.length - 1)];
      if (next) select(col, next);
    } else if (e.key === "ArrowRight") {
      if (!cur?.place) return;
      const first = columns[col + 1]?.entries[0];
      if (first) select(col + 1, first);
    } else if (e.key === "ArrowLeft") {
      // Step back to the parent: from a thing to its place, from a place to the one around it.
      if (itemId || col > 0) select(col - 1, { place: chain[col - 1]! });
      else select(0, null);
    } else if (e.key === "Enter" && cur) {
      void navigate(`/t/${entryId(cur)}`);
    } else return;
    e.preventDefault();
  };

  const n = filter.trim().toLowerCase();
  if (n) {
    const hits = places.filter(
      (p) => p.name.toLowerCase().includes(n) || p.position?.toLowerCase().includes(n),
    );
    return (
      <section className="panel">
        {hits.length ? (
          <ul className="pc-hits">
            {hits.slice(0, 100).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="pc-entry"
                  onClick={() => {
                    select(0, { place: p });
                    onPick();
                  }}
                >
                  <Thumb thing={p} />
                  <span className="pc-name">{p.name}</span>
                  <span className="muted small pc-trail">{trail(p, byId)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No places match.</p>
        )}
      </section>
    );
  }

  return (
    <section className="panel pc-panel">
      <nav className="pc-crumbs small" aria-label="Selected place">
        <button type="button" className="pc-crumb" onClick={() => select(0, null)}>
          All places
        </button>
        {chain.map((p, k) => (
          <span key={p.id}>
            {" › "}
            <button type="button" className="pc-crumb" onClick={() => select(k, { place: p })}>
              {p.name}
            </button>
          </span>
        ))}
        {item && (
          <span>
            {" › "}
            <span className="pc-crumb here">{item.name}</span>
          </span>
        )}
      </nav>
      <div
        className="pc-scroller"
        ref={scroller}
        tabIndex={0}
        role="tree"
        aria-label="Places, in columns"
        onKeyDown={onKey}
      >
        {columns.map((c, col) => (
          <Column
            key={c.parent?.id ?? "root"}
            parent={c.parent}
            entries={c.entries}
            loading={c.loading}
            selected={selectedIn(col)}
            active={col === (itemId ? chain.length : chain.length - 1)}
            kindName={kindName}
            onSelect={(e) => select(col, e)}
            onOpen={(e) => void navigate(`/t/${entryId(e)}`)}
            drag={drag}
          />
        ))}
        {item && <Preview item={item} kind={kindName(item.kind)} />}
      </div>
    </section>
  );
}

function Column({
  parent,
  entries,
  loading,
  selected,
  active,
  kindName,
  onSelect,
  onOpen,
  drag,
}: {
  parent: PlaceNode | null;
  entries: Entry[];
  loading: boolean;
  selected: string | null;
  active: boolean;
  kindName: (k: string) => string;
  onSelect: (e: Entry) => void;
  onOpen: (e: Entry) => void;
  drag: Drag;
}) {
  const drop = useDrop(parent?.id ?? null, parent?.name ?? "no place", drag);
  return (
    <div
      className={`pc-col${drop.over ? " drop" : ""}`}
      role="group"
      aria-label={parent?.name ?? "Rooms"}
      {...drop.props}
    >
      <div className="pc-head">
        {parent ? (
          <>
            <Link to={`/t/${parent.id}`} className="pc-cover" title="Open this place" tabIndex={-1}>
              <Thumb thing={parent} />
            </Link>
            <div className="pc-head-text">
              <Link to={`/t/${parent.id}`} className="pc-title" title="Open this place">
                {parent.name}
              </Link>
              <span className="muted small">
                {kindName(parent.kind)} · {parent.total ? `${parent.total} inside` : "empty"}
              </span>
            </div>
          </>
        ) : (
          <div className="pc-head-text">
            <span className="pc-title">Rooms</span>
            <span className="muted small">{entries.length} places</span>
          </div>
        )}
      </div>
      <ul className="pc-list">
        {entries.map((e) => (
          <Row
            key={entryId(e)}
            e={e}
            sel={entryId(e) === selected}
            active={active}
            kind={e.place ? kindName(e.place.kind) : ""}
            onSelect={() => onSelect(e)}
            onOpen={() => onOpen(e)}
            drag={drag}
          />
        ))}
        {loading && <li className="muted small pc-note">Loading…</li>}
        {!loading && !entries.length && <li className="muted small pc-note">Nothing here yet</li>}
      </ul>
    </div>
  );
}

function Row({
  e,
  sel,
  active,
  kind,
  onSelect,
  onOpen,
  drag,
}: {
  e: Entry;
  sel: boolean;
  active: boolean;
  kind: string;
  onSelect: () => void;
  onOpen: () => void;
  drag: Drag;
}) {
  const t = e.place ?? e.item;
  // Only places take drops; the hook still runs for items so hook order stays fixed.
  const drop = useDrop(t.id, t.name, drag);
  const hasKids = e.place ? e.place.total > 0 : false;
  return (
    <li
      className={`pc-entry${sel ? " sel" : ""}${sel && active ? " active" : ""}${drop.over && e.place ? " drop" : ""}`}
      role="treeitem"
      aria-selected={sel}
      onClick={onSelect}
      onDoubleClick={onOpen}
      title={e.place ? `${t.name} · ${kind}` : t.name}
      {...dragSource({ id: t.id, parentId: t.parentId, name: t.name }, drag)}
      {...(e.place ? drop.props : {})}
    >
      <Thumb thing={t} />
      <span className="pc-name">{t.name}</span>
      {t.position && <span className="spot-chip">{t.position}</span>}
      {e.item && typeof e.item.data.quantity === "number" && e.item.data.quantity > 1 && (
        <span className="muted small">×{e.item.data.quantity}</span>
      )}
      {t.status === "missing" && <span className="small pc-missing">missing</span>}
      {e.place && (
        <span className="pc-count small" aria-label={`${e.place.total} inside`}>
          {e.place.total || ""}
          <span className="pc-chev" aria-hidden="true">
            {hasKids ? "›" : ""}
          </span>
        </span>
      )}
    </li>
  );
}

function Preview({ item, kind }: { item: ThingView; kind: string }) {
  const qty = item.data.quantity;
  return (
    <aside className="pc-col pc-preview" aria-label="Selected thing">
      <Thumb thing={item} size="big" />
      <Link to={`/t/${item.id}`} className="pc-title">
        {item.name}
      </Link>
      <span className="muted small">
        {kind} · {item.id}
        {typeof qty === "number" && qty > 1 ? ` · ×${qty}` : ""}
      </span>
      {item.position && (
        <span className="small">
          Spot: <span className="spot-chip">{item.position}</span>
        </span>
      )}
      {item.status === "missing" && <span className="small pc-missing">Marked missing</span>}
      {item.tags.length > 0 && (
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          {item.tags.map((tg) => (
            <span key={tg.id} className="chip">
              {tg.name}
            </span>
          ))}
        </div>
      )}
      {item.childCount > 0 && (
        <span className="muted small">
          {item.childCount} {item.childCount === 1 ? "thing" : "things"} inside
        </span>
      )}
      <Link to={`/t/${item.id}`} className="btn small">
        Open →
      </Link>
    </aside>
  );
}

/** "Living room › IVAR" for a filter hit: where the place itself sits. */
function trail(p: PlaceNode, byId: Map<string, PlaceNode>) {
  const out: string[] = [];
  for (
    let x = p.parentId ? byId.get(p.parentId) : undefined;
    x && out.length < 64;
    x = x.parentId ? byId.get(x.parentId) : undefined
  )
    out.unshift(x.name);
  return out.join(" › ");
}
