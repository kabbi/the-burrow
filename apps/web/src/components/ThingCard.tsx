import { Link } from "react-router";
import type { ThingView } from "../lib/api.ts";
import { post } from "../lib/api.ts";
import { useAction } from "../lib/hooks.ts";

export function Thumb({ thing, big }: { thing: Pick<ThingView, "name" | "data">; big?: boolean }) {
  const src = (thing.data.thumbUrl ?? thing.data.imageUrl) as string | undefined;
  if (src)
    return (
      <img
        className={`thumb${big ? " big" : ""}`}
        src={big ? ((thing.data.imageUrl as string) ?? src) : src}
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

export function PathView({ thing }: { thing: ThingView }) {
  if (!thing.path.length) return null;
  return (
    <span className={`path${thing.status === "missing" ? " gone" : ""}`}>
      {thing.path.map((p, i) => (
        <span key={p.id} className="row" style={{ gap: 4 }}>
          {i > 0 && <span className="sep">›</span>}
          <Link className="seg" to={`/t/${p.id}`}>
            {p.name}
          </Link>
        </span>
      ))}
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
        <PathView thing={thing} />
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
