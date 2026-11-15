import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, post, type BurrowEvent, type ThingDetail } from "../lib/api.ts";
import { eventLabel } from "../lib/events.ts";
import { Icon } from "../ui/Icon.tsx";
import { Menu } from "../ui/parts.tsx";
import { MovePicker } from "../ui/MovePicker.tsx";
import { timeAgo, useAction, useUndo } from "../lib/hooks.ts";
import { useSchema } from "../lib/schema.ts";
import { Facts, GuessesHeader, guessKeys } from "../components/Facts.tsx";
import { StatusPill, ThingCard, Thumb, Where } from "../components/ThingCard.tsx";
import { AiSuggest } from "../components/AiSuggest.tsx";
import { TagEditor } from "../components/Tags.tsx";
import { Relations } from "../components/Relations.tsx";
import { Assets } from "../components/Assets.tsx";
import { BoardViewer } from "../components/BoardViewer.tsx";
import { LinkEnrich } from "../components/LinkEnrich.tsx";
import { isUrl } from "../lib/page.ts";
import { Who } from "../components/Who.tsx";

export function Thing() {
  const { id = "" } = useParams();
  const { data, error } = useQuery({
    queryKey: ["thing", id],
    queryFn: () => get<ThingDetail>(`/things/${id}`),
  });
  const { data: schema } = useSchema();
  const act = useAction();
  const navigate = useNavigate();
  const [moving, setMoving] = useState(false);
  /** The "Add product link" panel: closed, or open (with a pasted URL). */
  const [linkingAt, setLinking] = useState<{ id: string; url?: string } | null>(null);
  const linking = linkingAt?.id === id ? linkingAt : null;

  // Paste a product link anywhere on the page (outside a text box) to open the panel with it.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable]")) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (!isUrl(text)) return;
      e.preventDefault();
      setLinking({ id, url: text.trim() });
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [id]);

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

  const isPlace = kind?.isPlace ?? false;
  const kindGuessed = t.meta.kind?.source === "ai" && !t.meta.kind.confirmed;

  const inside = data.children.length > 0 && (
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
  );

  function menuItems() {
    return [
      {
        label: typeof t.data.url === "string" ? "Read the product link again" : "Add a product link",
        icon: "link" as const,
        hidden: isTag || isDoc || Boolean(linking),
        run: () => setLinking({ id }),
      },
      {
        label: "No fixed place",
        icon: "bag" as const,
        hidden: !physical || t.roams || isPlace,
        run: () =>
          void act(
            () => post(`/things/${t.id}/move`, { to: null, roams: true }),
            `${t.name}: no fixed place`,
          ),
      },
      {
        label: "Archive",
        icon: "box" as const,
        hidden: Boolean(t.archivedAt),
        run: () => void act(() => post(`/things/${t.id}/archive`), `${t.name} archived`),
      },
    ];
  }

  const missing = t.status === "missing";
  const markFound = () =>
    act(() => post(`/things/${t.id}/status`, { status: "ok", note: "found" }), "Marked as found");
  const notHere = () =>
    act(
      () => post(`/things/${t.id}/status`, { status: "missing" }),
      "Noted. Burrow stops trusting that spot until it turns up.",
    );
  const created = data.events.at(-1);

  return (
    <main className="page wide thing-page">
      <div className="thing-back">
        <button type="button" className="btn ghost small" onClick={() => navigate(-1)}>
          <Icon name="back" size={18} stroke={2.2} />
          Back
        </button>
        <Menu label="More: product link, archive" items={menuItems()} />
      </div>
      <section className="panel thing-head">
        <a href="#pictures" className="thing-cover" aria-label="Pictures" tabIndex={isTag ? -1 : 0}>
          <Thumb thing={t} size="big" />
        </a>
        <div className="thing-info">
          <span className="row" style={{ gap: 8 }}>
            <span className="idbadge">{t.id}</span>
            <span
              className={`tag${kindGuessed ? " ai" : ""}`}
              title={kindGuessed ? "Kind guessed by AI" : undefined}
            >
              {kindGuessed && <Icon name="sparkle" size={12} />}
              {kind?.name ?? t.kind}
            </span>
            {t.archivedAt && <span className="tag">archived</span>}
            {created && (
              <span className="small muted">
                added {new Date(created.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}{" "}
                by <Who actor={created.actor} />
              </span>
            )}
          </span>
          <h1 className="thing-title">{t.name}</h1>
          {typeof t.data.productName === "string" && t.data.productName !== t.name && (
            <ProductName name={t.data.productName} url={typeof t.data.url === "string" ? t.data.url : null} />
          )}
          {(physical || t.parentId) && (
            <span className="row thing-where">
              {!t.roams && (
                <span style={{ color: "var(--muted)" }}>
                  <Icon name="pin" size={16} />
                </span>
              )}
              <Where thing={t} chips />
              {t.parentId && <SpotEditor thing={t} spots={data.spots} />}
              {physical && <StatusPill thing={t} />}
            </span>
          )}
          {!isTag && <TagEditor thing={t} />}
        </div>
        <div className="thing-acts">
          {missing && physical ? (
            <button type="button" className="btn main big" onClick={markFound}>
              <Icon name="check" size={16} stroke={2.4} />
              Found it
            </button>
          ) : (
            <button
              type="button"
              className="btn main big"
              aria-expanded={moving}
              onClick={() => setMoving((m) => !m)}
            >
              <Icon name="move" size={16} stroke={2.4} />
              {moving ? "Done" : isTag ? "Nest under…" : t.parentId ? "Move" : "Put somewhere"}
            </button>
          )}
          {physical && !missing && t.parentId && (
            <button type="button" className="btn big" onClick={notHere}>
              It’s not here
            </button>
          )}
          {missing && physical && (
            <button type="button" className="btn big" onClick={() => setMoving((m) => !m)}>
              Found it elsewhere
            </button>
          )}
          {isDoc && data.paperlessId && (
            <Link className="btn big" to={`/papers?doc=${data.paperlessId}`}>
              Open in Papers
            </Link>
          )}
          <Menu big label="More: product link, archive" items={menuItems()} />
        </div>
        {moving && (
          <div style={{ flexBasis: "100%" }}>
            {isTag ? (
              <TagParentPicker id={t.id} onDone={() => setMoving(false)} />
            ) : (
              <MovePicker thing={t} onDone={() => setMoving(false)} />
            )}
          </div>
        )}
      </section>

      <div className="thing-cols">
        <div className="thing-main">
          {linking && !isTag && !isDoc && (
            <section className="panel stack">
              <h2 className="eyebrow">Fill in from a product page</h2>
              <LinkEnrich
                key={linking.url ?? ""}
                thing={t}
                assets={data.assets}
                {...(linking.url ? { initialUrl: linking.url } : {})}
                onClose={() => setLinking(null)}
              />
            </section>
          )}

          {data.assets.some((a) => a.data.view === "top" || a.data.view === "bottom") && (
            <BoardViewer key={t.id} assets={data.assets} />
          )}

          {isPlace && inside}

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
            <div className="row panel-head">
              <h2 className="eyebrow grow">What Burrow knows</h2>
              <GuessesHeader thing={t} fields={data.fields} />
              {!isTag && !isDoc && guessKeys(t, data.fields).length === 0 && (
                <AiSuggest
                  compact
                  thingId={t.id}
                  input={{ name: t.name, ...(typeof t.data.url === "string" ? { url: t.data.url } : {}) }}
                  onApplied={() => {}}
                />
              )}
            </div>
            <Facts thing={t} fields={data.fields} />
          </section>

          {!isPlace && inside}
        </div>

        <aside className="thing-side">
          {!isTag && (
            <Assets
              thingId={t.id}
              thingName={t.name}
              assets={data.assets}
              coverId={data.coverId}
              shownId={t.cover?.id ?? null}
            />
          )}

          {!isTag && (
            <section className="panel stack">
              <h2 className="eyebrow">Links</h2>
              <Relations thingId={t.id} thingKind={t.kind} relations={data.relations} />
              {!isDoc && !data.relations.some((r) => r.type === "has_document") && (
                <p className="muted small" style={{ margin: 0 }}>
                  Receipts and manuals: link them from the <Link to="/papers">Papers inbox</Link>.
                </p>
              )}
            </section>
          )}

          <History key={t.id} events={data.events} />
        </aside>
      </div>
    </main>
  );
}

/** The shop's name for it, under the household's name (D-023). */
function ProductName({ name, url }: { name: string; url: string | null }) {
  return (
    <span className="muted" style={{ marginTop: -4 }}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
          {name} ↗
        </a>
      ) : (
        name
      )}
    </span>
  );
}

/** "Where exactly inside": a short free-text spot kept with the move (D-016). */
function SpotEditor({ thing, spots }: { thing: ThingDetail["thing"]; spots: string[] }) {
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(thing.position ?? "");
  const parent = thing.path.at(-1)?.name ?? "its place";
  const save = (position: string | null) => {
    setEditing(false);
    if ((position ?? "") === (thing.position ?? "")) return;
    void act(
      () => post(`/things/${thing.id}/move`, { to: thing.parentId, position }),
      position ? `Spot: ${position}` : "Spot cleared",
    );
  };
  // The spot itself shows in the path; this is just the small way to set or change it.
  if (!editing)
    return (
      <button
        type="button"
        className="chip mini dashed"
        title={
          thing.position ? `Change the spot in ${parent}` : `Where exactly in ${parent}? (shelf, drawer…)`
        }
        onClick={() => {
          setValue(thing.position ?? "");
          setEditing(true);
        }}
      >
        {thing.position ? "change spot" : "+ spot"}
      </button>
    );
  return (
    <form
      className="row"
      style={{ flexBasis: "100%" }}
      onSubmit={(e) => {
        e.preventDefault();
        save(value.trim() || null);
      }}
    >
      <input
        className="input"
        style={{ maxWidth: 260, minHeight: 36 }}
        autoFocus
        list="spot-suggestions"
        maxLength={80}
        placeholder="shelf 3, top left, back…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
        aria-label={`Spot in ${parent}`}
      />
      <datalist id="spot-suggestions">
        {spots.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <button type="submit" className="btn small">
        Save
      </button>
      {thing.position && (
        <button type="button" className="btn small ghost" onClick={() => save(null)}>
          Clear
        </button>
      )}
    </form>
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

const HISTORY_SHOWN = 8;

function History({ events }: { events: (BurrowEvent & { undoable: boolean })[] }) {
  const undo = useUndo();
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, HISTORY_SHOWN);
  return (
    <section className="panel stack" style={{ gap: 6 }}>
      <h2 className="eyebrow">History · {events.length}</h2>
      <ol className="hist">
        {shown.map((e) => (
          <li key={e.seq} className={e.undone ? "undone" : ""}>
            <span className="hist-what">{eventLabel(e)}</span>
            <span className="hist-meta">
              <Who actor={e.actor} /> · {timeAgo(e.at)}
              {e.undoable && (
                <button type="button" className="linkbtn" onClick={() => undo.mutate(e.seq)}>
                  {e.undone ? "redo" : "undo"}
                </button>
              )}
            </span>
          </li>
        ))}
      </ol>
      {events.length > HISTORY_SHOWN && (
        <button
          type="button"
          className="linkbtn small"
          style={{ alignSelf: "flex-start" }}
          onClick={() => setAll((a) => !a)}
        >
          {all ? "Show fewer" : `Show all ${events.length}`}
        </button>
      )}
    </section>
  );
}
