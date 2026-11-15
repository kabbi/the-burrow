import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, post, type PlaceNode, type ThingView } from "../lib/api.ts";
import { useAction } from "../lib/hooks.ts";
import { useSchema } from "../lib/schema.ts";
import { Thumb } from "../components/ThingCard.tsx";
import { PlaceColumns } from "../components/PlaceColumns.tsx";
import { dragSource, useDrop, type Drag, type Dragged } from "../components/placeDrag.ts";

const OPEN_KEY = "burrow.places.open";
const VIEW_KEY = "burrow.places.view";
type View = "tree" | "columns";
type Tree = { places: PlaceNode[]; unplaced: number };

function loadOpen(): Set<string> | null {
  try {
    const v = localStorage.getItem(OPEN_KEY);
    return v ? new Set(JSON.parse(v) as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * Rooms → furniture → boxes, with how many things are in each (D-016).
 * Open a place to see what's directly inside; drag a box or a thing onto
 * another place to move it.
 */
export function Places() {
  const { data } = useQuery({ queryKey: ["places-tree"], queryFn: () => get<Tree>("/places/tree") });
  const { data: schema } = useSchema();
  const act = useAction();
  const [q, setQ] = useState("");
  const [room, setRoom] = useState("");
  const [openSet, setOpenSet] = useState<Set<string> | null>(loadOpen);
  const [dragging, setDragging] = useState<Dragged | null>(null);
  const [params] = useSearchParams();
  // A link with ?at= is a columns link; otherwise the view this browser used last.
  const [view, setViewState] = useState<View>(() => {
    if (params.has("at")) return "columns";
    try {
      return localStorage.getItem(VIEW_KEY) === "columns" ? "columns" : "tree";
    } catch {
      return "tree";
    }
  });
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // private mode: the default view comes back next time
    }
  };

  const places = data?.places ?? [];
  const byParent = new Map<string | null, PlaceNode[]>();
  const ids = new Set(places.map((p) => p.id));
  for (const p of places) {
    // A place inside a non-place (rare) is shown at the top so it isn't lost.
    const key = p.parentId && ids.has(p.parentId) ? p.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), p]);
  }
  const kindName = (k: string) => schema?.kinds.find((x) => x.id === k)?.name ?? k;

  // Filtering shows matches with their ancestors, all open.
  const n = q.trim().toLowerCase();
  const visible = n
    ? new Set(
        places
          .filter((p) => p.name.toLowerCase().includes(n) || p.position?.toLowerCase().includes(n))
          .flatMap((p) => [p.id, ...ancestors(p, places)]),
      )
    : null;
  const open = (id: string, depth: number) => (visible ? true : openSet ? openSet.has(id) : depth === 0); // default: rooms open
  const toggle = (id: string, depth: number) => {
    const next = new Set(
      openSet ?? places.filter((p) => !p.parentId || !ids.has(p.parentId)).map((p) => p.id),
    );
    if (open(id, depth)) next.delete(id);
    else next.add(id);
    setOpenSet(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
    } catch {
      // private mode: the tree just forgets what was open
    }
  };
  const setAll = (all: boolean) => {
    const next = new Set(all ? places.map((p) => p.id) : []);
    setOpenSet(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
    } catch {
      // fine
    }
  };

  const moveTo = (to: string | null, toName: string) => {
    const d = dragging;
    setDragging(null);
    if (!d || d.id === to || d.parentId === to) return;
    void act(() => post(`/things/${d.id}/move`, { to }), `${d.name} → ${toName}`);
  };
  const drag: Drag = { dragging, setDragging, moveTo };

  const branch = (parent: string | null, depth: number) => {
    const kids = (byParent.get(parent) ?? []).filter((p) => !visible || visible.has(p.id));
    if (!kids.length) return null;
    return (
      <ul className={depth === 0 ? "places-tree" : undefined}>
        {kids.map((p) => {
          const isOpen = open(p.id, depth);
          const hasKids = (byParent.get(p.id)?.length ?? 0) > 0 || p.items > 0;
          return (
            <li key={p.id}>
              <PlaceRow
                p={p}
                kind={kindName(p.kind)}
                isOpen={isOpen}
                hasKids={hasKids}
                onToggle={() => toggle(p.id, depth)}
                drag={drag}
              />
              {isOpen && (
                <>
                  {branch(p.id, depth + 1)}
                  {p.items > 0 && <PlaceItems placeId={p.id} placeIds={ids} drag={drag} />}
                </>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <main className="page">
      <div className="row places-bar">
        <h1>Places</h1>
        <input
          className="input"
          placeholder="Filter places…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Filter places"
        />
        <div className="seg-group" role="group" aria-label="View">
          {(["tree", "columns"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className="chip"
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {v === "tree" ? "Tree" : "Columns"}
            </button>
          ))}
        </div>
        {view === "tree" && (
          <>
            <button type="button" className="btn small" onClick={() => setAll(true)}>
              Open all
            </button>
            <button type="button" className="btn small" onClick={() => setAll(false)}>
              Close all
            </button>
          </>
        )}
        <form
          className="row places-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (!room.trim()) return;
            void act(
              () => post("/things", { name: room.trim(), kind: "room" }),
              `Room “${room.trim()}” added`,
            );
            setRoom("");
          }}
        >
          <input
            className="input"
            placeholder="New room"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            aria-label="New room name"
          />
          <button type="submit" className="btn small">
            Add
          </button>
        </form>
      </div>

      {view === "columns" && places.length > 0 ? (
        <PlaceColumns
          places={places}
          byParent={byParent}
          placeIds={ids}
          kindName={kindName}
          drag={drag}
          filter={q}
          onPick={() => setQ("")}
        />
      ) : (
        <section className="panel">
          {dragging && dragging.parentId && (
            <DropZone label="Drop here to take it out of its place" onDrop={() => moveTo(null, "no place")} />
          )}
          {branch(null, 0) ?? (
            <p className="muted">{places.length ? "No places match." : "No places yet."}</p>
          )}
        </section>
      )}

      <p className="small muted">
        {data && data.unplaced > 0 && (
          <>
            <Link to="/later">
              {data.unplaced} {data.unplaced === 1 ? "thing isn't" : "things aren't"} anywhere yet →
            </Link>{" "}
            ·{" "}
          </>
        )}
        Drag a box or a thing onto a place to move it
        {view === "columns" && " · arrow keys move, Enter opens"}
      </p>
    </main>
  );
}

function PlaceRow({
  p,
  kind,
  isOpen,
  hasKids,
  onToggle,
  drag,
}: {
  p: PlaceNode;
  kind: string;
  isOpen: boolean;
  hasKids: boolean;
  onToggle: () => void;
  drag: Drag;
}) {
  const drop = useDrop(p.id, p.name, drag);
  return (
    <div
      className={`place-row${drop.over ? " drop" : ""}`}
      {...dragSource({ id: p.id, parentId: p.parentId, name: p.name }, drag)}
      {...drop.props}
    >
      <button
        type="button"
        className="twisty"
        disabled={!hasKids}
        aria-expanded={isOpen}
        aria-label={`${isOpen ? "Close" : "Open"} ${p.name}`}
        onClick={onToggle}
      >
        {isOpen ? "▾" : "▸"}
      </button>
      <Thumb thing={p} />
      <Link className="name" to={`/t/${p.id}`}>
        {p.name}
      </Link>
      <span className="muted small">{kind}</span>
      {p.position && <span className="spot-chip">{p.position}</span>}
      <span className="count-chip" title={`${p.items} directly here, ${p.total} inside in total`}>
        {p.total ? `${p.total} ${p.total === 1 ? "thing" : "things"}` : "empty"}
      </span>
    </div>
  );
}

/** The things (not places) directly inside a place, loaded when it is opened. */
function PlaceItems({ placeId, placeIds, drag }: { placeId: string; placeIds: Set<string>; drag: Drag }) {
  const { data } = useQuery({
    queryKey: ["things", { parent: placeId }],
    queryFn: () => get<{ things: ThingView[] }>(`/things?parent=${placeId}&order=name&limit=500`),
  });
  const items = (data?.things ?? []).filter((t) => !placeIds.has(t.id));
  if (!items.length) return null;
  return (
    <ul>
      {items.map((t) => (
        <li
          key={t.id}
          className="item-row"
          {...dragSource({ id: t.id, parentId: t.parentId, name: t.name }, drag)}
        >
          <Thumb thing={t} />
          <Link to={`/t/${t.id}`}>{t.name}</Link>
          {typeof t.data.quantity === "number" && t.data.quantity > 1 && (
            <span className="muted small">×{t.data.quantity}</span>
          )}
          {t.position && <span className="spot-chip">{t.position}</span>}
          {t.status === "missing" && (
            <span className="small" style={{ color: "var(--bad)" }}>
              missing
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function DropZone({ label, onDrop }: { label: string; onDrop: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`place-row muted small${over ? " drop" : ""}`}
      style={{ justifyContent: "center", border: "1px dashed var(--line-2)", marginBottom: 8 }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop();
      }}
    >
      {label}
    </div>
  );
}

function ancestors(p: PlaceNode, all: PlaceNode[]): string[] {
  const out: string[] = [];
  for (
    let x = all.find((y) => y.id === p.parentId);
    x && out.length < 64;
    x = all.find((y) => y.id === x!.parentId)
  )
    out.push(x.id);
  return out;
}
