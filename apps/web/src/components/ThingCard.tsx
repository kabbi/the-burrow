import { useState } from "react";
import { Link } from "react-router";
import type { ThingView } from "../lib/api.ts";
import { post } from "../lib/api.ts";
import { useAction } from "../lib/hooks.ts";

/** The thing's cover picture (D-015), or its initial. Icons and sprites are drawn whole. */
export function Thumb({ thing, big }: { thing: Pick<ThingView, "name" | "cover">; big?: boolean }) {
  const c = thing.cover;
  const src = big ? (c?.imageUrl ?? c?.thumbUrl) : (c?.thumbUrl ?? c?.imageUrl);
  if (c && src)
    return (
      <img
        className={`thumb${big ? " big" : ""}${c.role === "icon" || c.role === "sprite" ? " contain" : ""}`}
        src={src}
        alt=""
        loading="lazy"
      />
    );
  return (
    <span className={`thumb${big ? " big" : ""}`} aria-hidden="true">
      {thing.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Where a thing is: Living room › IVAR · shelf 3 › Crate. A spot ("shelf 3") belongs to the
 * thing inside, so it is shown after its parent. `compact` keeps the room and the last two
 * steps (Living room › … › Crate › Modubox); "…" expands, the full path is in the tooltip.
 */
export function PathView({
  thing,
  compact,
}: {
  thing: Pick<ThingView, "path" | "position" | "status">;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const path = thing.path;
  if (!path.length) return null;
  const spotAfter = (i: number) => (i + 1 < path.length ? path[i + 1]!.position : thing.position) ?? null;
  const full = path.map((p, i) => p.name + (spotAfter(i) ? ` (${spotAfter(i)})` : "")).join(" › ");
  const fold = compact && !open && path.length > 3;
  const shown = fold ? [0, path.length - 2, path.length - 1] : path.map((_, i) => i);
  return (
    <span className={`path${thing.status === "missing" ? " gone" : ""}`} title={full}>
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
                  className="seg more"
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
              {spot && <span className="spot">{spot}</span>}
            </Link>
          </span>
        );
      })}
    </span>
  );
}

const STATUS_TEXT: Record<ThingView["status"], string> = {
  ok: "Where it should be",
  unverified: "Not checked lately",
  missing: "Not where Burrow thought — you said it’s not there",
};

export function StatusLine({ thing }: { thing: ThingView }) {
  const aiPlace = thing.meta.parent?.source === "ai" && !thing.meta.parent.confirmed;
  const unplaced = !thing.parentId && thing.status === "ok";
  return (
    <span className="status-line">
      <span className={`dot ${aiPlace ? "ai" : unplaced ? "unverified" : thing.status}`} />
      {aiPlace
        ? "Place guessed by AI — not checked"
        : unplaced
          ? "Not placed yet"
          : STATUS_TEXT[thing.status]}
      {typeof thing.data.quantity === "number" && <span className="tag">×{thing.data.quantity}</span>}
    </span>
  );
}

/**
 * The one item card (design "shared skeleton"): picture, name, one status line,
 * where it is, then actions. Main action first, “It’s not here” always second.
 */
export function ThingCard({ thing, compact }: { thing: ThingView; compact?: boolean }) {
  const act = useAction();
  const notHere = () =>
    act(
      () =>
        post<{ event: never }>(`/things/${thing.id}/status`, {
          status: "missing",
          note: "not at the expected place",
        }),
      `Noted: ${thing.name} isn’t at ${thing.path.at(-1)?.name ?? "that spot"}`,
    );
  const foundIt = () =>
    act(
      () => post<{ event: never }>(`/things/${thing.id}/status`, { status: "ok", note: "found" }),
      `Found ${thing.name}`,
    );
  return (
    <article className="card">
      <Thumb thing={thing} />
      <div className="body">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <Link className="title" to={`/t/${thing.id}`}>
            {thing.name}
          </Link>
          <Link className="idbadge" to={`/t/${thing.id}`}>
            {thing.id}
          </Link>
        </div>
        <StatusLine thing={thing} />
        <PathView thing={thing} compact />
        {!compact && (
          <div className="row" style={{ marginTop: 4 }}>
            {thing.status === "missing" ? (
              <button type="button" className="btn small" onClick={foundIt}>
                I found it
              </button>
            ) : (
              thing.parentId && (
                <button type="button" className="btn small" onClick={notHere}>
                  It’s not here
                </button>
              )
            )}
            {thing.gaps.length > 0 && <span className="muted small">needs: {thing.gaps.join(", ")}</span>}
          </div>
        )}
      </div>
    </article>
  );
}
