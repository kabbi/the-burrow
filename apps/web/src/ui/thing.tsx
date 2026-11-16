import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { post, type ThingView } from "../lib/api.ts";
import { useAction } from "../lib/hooks.ts";
import { Icon } from "./Icon.tsx";
import { MovePicker } from "./MovePicker.tsx";

/** The thing's cover picture (D-015), or its initial. Icons and sprites are drawn whole. */
export function Thumb({
  thing,
  size,
}: {
  thing: Pick<ThingView, "name" | "cover">;
  size?: "small" | "big" | "tod";
}) {
  const c = thing.cover;
  const big = size === "big";
  const src = big ? (c?.imageUrl ?? c?.thumbUrl) : (c?.thumbUrl ?? c?.imageUrl);
  const cls = `thumb${size ? ` ${size}` : ""}`;
  if (c && src)
    return (
      <img
        className={`${cls}${c.role === "icon" || c.role === "sprite" ? " contain" : ""}`}
        src={src}
        alt=""
        loading="lazy"
      />
    );
  return (
    <span className={cls} aria-hidden="true">
      {thing.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Where a thing is: Working Room › IVAR · shelf 3 › Crate. A spot ("shelf 3") belongs to the
 * thing inside, so it follows its parent after a dot. `compact` keeps the room and the last
 * step (Working Room › … › Crate) on one line, the room shortening first so the last step stays
 * readable; "…" expands, the full path is in the tooltip. The last step is bold. `chips` draws each step as a tappable chip (the thing page).
 */
export function PathView({
  thing,
  compact,
  chips,
}: {
  thing: Pick<ThingView, "path" | "position" | "status">;
  compact?: boolean;
  chips?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const path = thing.path;
  if (!path.length) return null;
  const spotAfter = (i: number) => (i + 1 < path.length ? path[i + 1]!.position : thing.position) ?? null;
  const full = path.map((p, i) => p.name + (spotAfter(i) ? ` (${spotAfter(i)})` : "")).join(" › ");
  const fold = compact && !open && path.length > 2;
  const shown = fold ? [0, path.length - 1] : path.map((_, i) => i);
  const cls = `path${chips ? " chips" : ""}${fold ? " folded" : ""}${thing.status === "missing" ? " gone" : ""}`;
  return (
    <span className={cls} title={full}>
      {shown.map((i, k) => {
        const p = path[i]!;
        const spot = spotAfter(i);
        return (
          <span key={p.id} className="row" style={{ gap: 4 }}>
            {k > 0 && <span className="sep">›</span>}
            {fold && k === 1 && (
              <>
                <button
                  type="button"
                  className="more"
                  aria-label={`Show full path: ${full}`}
                  onClick={() => setOpen(true)}
                >
                  …
                </button>
                <span className="sep">›</span>
              </>
            )}
            <Link className="seg" to={`/t/${p.id}`}>
              {p.name}
            </Link>
            {spot && <span className="spot">{spot}</span>}
          </span>
        );
      })}
    </span>
  );
}

/** The two nowheres (D-026): a gap to fill, and a thing that travels. */
export function Nowhere({ roams, big }: { roams: boolean; big?: boolean }) {
  return roams ? (
    <span className={`nowhere roams${big ? " big" : ""}`}>
      <Icon name="bag" size={14} />
      No fixed place
    </span>
  ) : (
    <span className={`nowhere gap${big ? " big" : ""}`}>Not placed yet</span>
  );
}

/** Path, or which nowhere it's in. Rooms, tags and papers show nothing. */
export function Where({
  thing,
  compact,
  chips,
}: {
  thing: Pick<ThingView, "path" | "position" | "status" | "roams" | "gaps">;
  compact?: boolean;
  chips?: boolean;
}) {
  if (thing.path.length) return <PathView thing={thing} compact={compact} chips={chips} />;
  if (thing.roams) return <Nowhere roams big={chips} />;
  if (thing.gaps.includes("where")) return <Nowhere roams={false} big={chips} />;
  return null;
}

/** Fields an AI filled that nobody has checked yet. */
export function uncheckedAi(t: Pick<ThingView, "meta" | "data" | "name">): string[] {
  return Object.entries(t.meta)
    .filter(([k, m]) => m.source === "ai" && !m.confirmed && k !== "parent")
    .filter(([k]) => k === "name" || k === "kind" || t.data[k] !== undefined)
    .map(([k]) => k);
}

/**
 * The status of a thing, only when it isn't fine ("Fine is silent"). A word with an icon,
 * colour agrees.
 */
export function StatusPill({ thing }: { thing: ThingView }) {
  if (thing.status === "missing")
    return (
      <span className="pill bad">
        <Icon name="alert" size={14} stroke={2.2} />
        Missing{thing.path.length ? ` · last in ${thing.path.at(-1)!.name}` : ""}
      </span>
    );
  if (thing.meta.parent?.source === "ai" && !thing.meta.parent.confirmed)
    return (
      <span className="pill ai">
        <Icon name="sparkle" size={14} />
        Place guessed by AI
      </span>
    );
  const ai = uncheckedAi(thing).length;
  if (ai)
    return (
      <span className="pill ai">
        <Icon name="sparkle" size={14} />
        {ai === 1 ? "1 AI guess to check" : `${ai} AI guesses to check`}
      </span>
    );
  if (thing.status === "unverified") return <span className="pill warn">Not checked lately</span>;
  return null;
}

/** "It's not here" / "Found it": always one tap away on a placed thing. */
export function useNotHere(thing: ThingView) {
  const act = useAction();
  return {
    notHere: () =>
      act(
        () => post(`/things/${thing.id}/status`, { status: "missing", note: "not at the expected place" }),
        `Noted: ${thing.name} isn’t in ${thing.path.at(-1)?.name ?? "its place"}`,
      ),
    found: () =>
      act(() => post(`/things/${thing.id}/status`, { status: "ok", note: "found" }), `Found ${thing.name}`),
  };
}

/**
 * The thing row: the one card, in list form. Picture · name + ID · where · a "why" line ·
 * status only if not fine · actions on the right (on hover with a mouse, always on touch).
 */
export function ThingRow({
  thing,
  why,
  actions = true,
  extra,
}: {
  thing: ThingView;
  /** A grey line under the path: "Found in the description". */
  why?: ReactNode;
  actions?: boolean;
  extra?: ReactNode;
}) {
  const { notHere, found } = useNotHere(thing);
  const [moving, setMoving] = useState(false);
  const qty = typeof thing.data.quantity === "number" ? thing.data.quantity : null;
  return (
    <div className="trow">
      <Link to={`/t/${thing.id}`} tabIndex={-1} aria-hidden="true">
        <Thumb thing={thing} />
      </Link>
      <div className="main">
        <div className="name">
          <Link to={`/t/${thing.id}`} title={thing.name}>
            {thing.name}
          </Link>
          <span className="idtext">{thing.id}</span>
          {qty !== null && <span className="tag">×{qty}</span>}
        </div>
        <Where thing={thing} compact />
        {why && <div className="why">{why}</div>}
      </div>
      <StatusPill thing={thing} />
      {extra}
      {actions && (
        <div className={`acts${thing.status === "missing" ? "" : " on-hover"}`}>
          {thing.status === "missing" ? (
            <button type="button" className="btn small" onClick={found}>
              Found it
            </button>
          ) : (
            <>
              <button type="button" className="btn small" onClick={() => setMoving((m) => !m)}>
                {thing.gaps.includes("where") ? "Place it" : "Move"}
              </button>
              {thing.parentId && (
                <button type="button" className="btn small" onClick={notHere}>
                  It’s not here
                </button>
              )}
            </>
          )}
        </div>
      )}
      {moving && (
        <div style={{ flexBasis: "100%" }}>
          <MovePicker thing={thing} onDone={() => setMoving(false)} />
        </div>
      )}
    </div>
  );
}

/** A compact tile for grids: picture, name, where, ID. */
export function ThingTile({ thing }: { thing: ThingView }) {
  return (
    <Link to={`/t/${thing.id}`} className="tcard">
      <Thumb thing={thing} />
      <span className="main">
        <span className="tname" title={thing.name}>
          {thing.name}
        </span>
        {thing.path.length ? (
          <span className="tpath" title={thing.path.map((p) => p.name).join(" › ")}>
            {thing.path.length > 1 && (
              <>
                <span className="first">{thing.path[0]!.name}</span>
                <span className="sep">{thing.path.length > 2 ? "› … ›" : "›"}</span>
              </>
            )}
            <b>{thing.path.at(-1)!.name}</b>
          </span>
        ) : thing.roams ? (
          <span className="small muted">No fixed place</span>
        ) : thing.gaps.includes("where") ? (
          <span className="small muted">Not placed yet</span>
        ) : null}
        <span className="idtext">{thing.id}</span>
      </span>
    </Link>
  );
}
