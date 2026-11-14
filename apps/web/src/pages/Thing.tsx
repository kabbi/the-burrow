import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, post, type BurrowEvent, type ThingDetail } from "../lib/api.ts";
import { timeAgo, useAction, useUndo } from "../lib/hooks.ts";
import { useSchema } from "../lib/schema.ts";
import { Facts } from "../components/Facts.tsx";
import { PlacePicker } from "../components/PlacePicker.tsx";
import { PathView, StatusLine, ThingCard, Thumb } from "../components/ThingCard.tsx";
import { AiSuggest } from "../components/AiSuggest.tsx";
import { TagEditor } from "../components/Tags.tsx";
import { Relations } from "../components/Relations.tsx";
import { Assets, ROLE_LABEL } from "../components/Assets.tsx";

export function Thing() {
  const { id = "" } = useParams();
  const { data, error } = useQuery({
    queryKey: ["thing", id],
    queryFn: () => get<ThingDetail>(`/things/${id}`),
  });
  const { data: schema } = useSchema();
  const act = useAction();
  const [moving, setMoving] = useState(false);

  if (error)
    return (
      <main className="page">
        <div className="empty">{(error as Error).message}</div>
      </main>
    );
  if (!data) return <main className="page" />;
  const t = data.thing;
  const kind = schema?.kinds.find((k) => k.id === t.kind);
  const isTag = kind?.isTag ?? t.kind === "tag";
  const isDoc = kind?.isDocument ?? t.kind === "document";
  const physical = kind?.physical ?? true;

  return (
    <main className="page">
      <section className="panel stack">
        <div className="row" style={{ alignItems: "flex-start", gap: 18 }}>
          <Thumb thing={t} big />
          <div className="stack grow" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="row" style={{ gap: 6 }}>
                <span className="idbadge" style={{ fontSize: 14 }}>
                  {t.id}
                </span>
                <span className="tag">{kind?.name ?? t.kind}</span>
              </span>
              {t.archivedAt && <span className="tag">archived</span>}
            </div>
            <h1 style={{ fontSize: 30 }}>{t.name}</h1>
            {physical && <StatusLine thing={t} />}
            <PathView thing={t} />
            {!isTag && <TagEditor thing={t} />}
            <div className="row" style={{ marginTop: 6 }}>
              <button type="button" className="btn main" onClick={() => setMoving((m) => !m)}>
                {moving ? "Done" : isTag ? "Nest under…" : t.parentId ? "Move" : "Put somewhere"}
              </button>
              {physical &&
                (t.status === "missing" ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      act(
                        () => post(`/things/${t.id}/status`, { status: "ok", note: "found" }),
                        "Marked as found",
                      )
                    }
                  >
                    I found it
                  </button>
                ) : (
                  t.parentId && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        act(
                          () => post(`/things/${t.id}/status`, { status: "missing" }),
                          "Noted — Burrow stops trusting that spot",
                        )
                      }
                    >
                      It’s not here
                    </button>
                  )
                ))}
              {isDoc && data.paperlessId && (
                <Link className="btn" to={`/papers?doc=${data.paperlessId}`}>
                  Open in Papers
                </Link>
              )}
              {!t.archivedAt && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => act(() => post(`/things/${t.id}/archive`), `${t.name} archived`)}
                >
                  Archive
                </button>
              )}
            </div>
            {moving &&
              (isTag ? (
                <TagParentPicker id={t.id} onDone={() => setMoving(false)} />
              ) : (
                <PlacePicker
                  label="Move to"
                  autoFocus
                  value={t.parentId}
                  onChange={(to) => {
                    setMoving(false);
                    void act(
                      () => post(`/things/${t.id}/move`, { to }),
                      to ? "Moved" : "Removed from its place",
                    );
                  }}
                />
              ))}
          </div>
        </div>
      </section>

      {!isTag && (
        <Assets
          thingId={t.id}
          thingName={t.name}
          assets={data.assets}
          coverId={data.coverId}
          shownId={t.cover?.id ?? null}
        />
      )}

      {isTag && (
        <section className="stack">
          <h2 className="eyebrow">Tagged · {data.tagged.length} (including nested tags)</h2>
          {data.tagged.length ? (
            <div className="grid2">
              {data.tagged.map((c) => (
                <ThingCard key={c.id} thing={c} compact />
              ))}
            </div>
          ) : (
            <p className="muted small">Nothing tagged yet.</p>
          )}
        </section>
      )}

      <section className="panel stack">
        <h2 className="eyebrow">What Burrow knows</h2>
        {!isTag && !isDoc && (
          <AiSuggest
            thingId={t.id}
            input={{ name: t.name, ...(typeof t.data.url === "string" ? { url: t.data.url } : {}) }}
            onApplied={() => {}}
          />
        )}
        <Facts thing={t} fields={data.fields} />
      </section>

      {!isTag && (
        <section className="panel stack">
          <h2 className="eyebrow">Links</h2>
          <Relations thingId={t.id} relations={data.relations} />
          {!isDoc && !data.relations.some((r) => r.type === "has_document") && (
            <p className="muted small" style={{ margin: 0 }}>
              Receipts and manuals: link them from the <Link to="/papers">Papers inbox</Link>.
            </p>
          )}
        </section>
      )}

      {data.children.length > 0 && (
        <section className="stack">
          <h2 className="eyebrow">
            {isTag ? "Nested tags" : "Inside"} · {data.children.length}
          </h2>
          <div className="grid2">
            {data.children.map((c) => (
              <ThingCard key={c.id} thing={c} compact />
            ))}
          </div>
        </section>
      )}

      <History events={data.events} />
    </main>
  );
}

/** Tags nest under other tags (their "parent"), using the same inside-relation as places. */
function TagParentPicker({ id, onDone }: { id: string; onDone: () => void }) {
  const act = useAction();
  const { data } = useQuery({
    queryKey: ["tags"],
    queryFn: () => get<{ tags: { id: string; name: string; path: string[] }[] }>("/tags"),
  });
  return (
    <label className="field">
      <span>Nest under</span>
      <select
        className="input"
        defaultValue=""
        onChange={(e) => {
          onDone();
          void act(() => post(`/things/${id}/move`, { to: e.target.value || null }), "Tag moved");
        }}
      >
        <option value="">(top level)</option>
        {data?.tags
          .filter((x) => x.id !== id)
          .map((x) => (
            <option key={x.id} value={x.id}>
              {[...x.path, x.name].join(" › ")}
            </option>
          ))}
      </select>
    </label>
  );
}

function label(e: BurrowEvent): string {
  const b = e.body;
  switch (b.type) {
    case "thing.created":
      return "Added";
    case "thing.changed":
      return `Changed ${b.changes.map((c) => c.field.replace(/^data\./, "")).join(", ")}`;
    case "thing.moved":
      return b.to ? "Moved" : "Taken out of its place";
    case "thing.status":
      return b.to === "missing" ? "Reported missing" : b.to === "ok" ? "Found" : "Marked not checked";
    case "thing.confirmed":
      return `${b.undo ? "Unconfirmed" : "Confirmed"} ${b.fields.join(", ")}`;
    case "thing.archived":
      return b.undo ? "Restored" : "Archived";
    case "ref.linked":
      return `Linked to ${b.service}`;
    case "edge.added":
      return b.edgeType === "tagged" ? "Tagged" : `Linked (${b.edgeType.replace(/_/g, " ")})`;
    case "edge.removed":
      return b.edgeType === "tagged" ? "Untagged" : `Unlinked (${b.edgeType.replace(/_/g, " ")})`;
    case "asset.added":
      return `Added ${ROLE_LABEL[b.asset.role].toLowerCase()}`;
    case "asset.changed":
      return b.to.thumb !== undefined && Object.keys(b.to).length === 1
        ? "New picture for a 3D model"
        : b.to.role
          ? `Picture is now: ${ROLE_LABEL[b.to.role].toLowerCase()}`
          : "Picture changed";
    case "asset.removed":
      return b.undo ? "Picture restored" : "Picture removed";
    case "asset.cover":
      return b.to ? "Cover changed" : "Cover automatic";
    default:
      return b.type;
  }
}

function History({ events }: { events: (BurrowEvent & { undoable: boolean })[] }) {
  const undo = useUndo();
  return (
    <section className="panel flat">
      <h2 className="eyebrow" style={{ margin: "12px 0 6px" }}>
        History
      </h2>
      <div className="list">
        {events.map((e) => (
          <div className="list-row" key={e.seq}>
            <span
              style={{
                flex: 1,
                color: e.undone ? "var(--muted)" : undefined,
                textDecoration: e.undone ? "line-through" : undefined,
              }}
            >
              {label(e)}
            </span>
            <span className="muted small">
              {e.actor} · {timeAgo(e.at)}
            </span>
            {e.undoable && (
              <button type="button" className="btn small" onClick={() => undo.mutate(e.seq)}>
                {e.undone ? "Redo" : "Undo"}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
