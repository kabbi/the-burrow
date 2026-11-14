import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, post, type BurrowEvent, type ThingDetail } from "../lib/api.ts";
import { timeAgo, useAction, useUndo } from "../lib/hooks.ts";
import { Facts } from "../components/Facts.tsx";
import { PlacePicker } from "../components/PlacePicker.tsx";
import { PathView, StatusLine, ThingCard, Thumb } from "../components/ThingCard.tsx";
import { AiSuggest } from "../components/AiSuggest.tsx";

export function Thing() {
  const { id = "" } = useParams();
  const { data, error } = useQuery({
    queryKey: ["thing", id],
    queryFn: () => get<ThingDetail>(`/things/${id}`),
  });
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
  const hb = t.refs.find((r) => r.service === "homebox");

  return (
    <main className="page">
      <section className="panel stack">
        <div className="row" style={{ alignItems: "flex-start", gap: 18 }}>
          <Thumb thing={t} big />
          <div className="stack grow" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="idbadge" style={{ fontSize: 14 }}>
                {t.id}
              </span>
              {t.archivedAt && <span className="tag">archived</span>}
            </div>
            <h1 style={{ fontSize: 30 }}>{t.name}</h1>
            <StatusLine thing={t} />
            <PathView thing={t} />
            <div className="row" style={{ marginTop: 6 }}>
              <button type="button" className="btn main" onClick={() => setMoving((m) => !m)}>
                {moving ? "Done" : "Move"}
              </button>
              {t.status === "missing" ? (
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
              {hb && <span className="muted small">HomeBox {String(hb.data.assetId ?? "")}</span>}
            </div>
            {moving && (
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
            )}
          </div>
        </div>
      </section>

      <section className="panel stack">
        <h2 className="eyebrow">What Burrow knows</h2>
        <AiSuggest
          thingId={t.id}
          input={{ name: t.name, ...(typeof t.data.url === "string" ? { url: t.data.url } : {}) }}
          onApplied={() => {}}
        />
        <Facts thing={t} />
      </section>

      {data.children.length > 0 && (
        <section className="stack">
          <h2 className="eyebrow">Inside · {data.children.length}</h2>
          <div className="grid2">
            {data.children.map((c) => (
              <ThingCard key={c.id} thing={c} compact />
            ))}
          </div>
        </section>
      )}

      <section className="panel stack">
        <h2 className="eyebrow">Papers</h2>
        {data.documents.length ? (
          <div className="list">
            {data.documents.map((d) => (
              <div className="list-row" key={d.id}>
                <Link to={`/papers?doc=${d.toId.split(":")[1]}`} style={{ flex: 1 }}>
                  {String(d.data.title || d.toId)}
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>
            No receipts or manuals linked. File one from the <Link to="/papers">Papers inbox</Link>.
          </p>
        )}
      </section>

      <History events={data.events} />
    </main>
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
