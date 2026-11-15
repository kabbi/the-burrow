import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  get,
  post,
  upload,
  type BurrowEvent,
  type Hits,
  type Place,
  type Preview,
  type ThingDetail,
  type ThingView,
} from "../lib/api.ts";
import { useDebounced, useRefresh, useUndo } from "../lib/hooks.ts";
import { useToast } from "../lib/toast.tsx";
import { PlacePicker } from "../components/PlacePicker.tsx";
import { Facts } from "../components/Facts.tsx";
import { TagEditor } from "../components/Tags.tsx";
import { useThingKinds } from "../lib/schema.ts";
import { AiSuggest } from "../components/AiSuggest.tsx";
import { aiInput as pageAiInput, isUrl, pageData } from "../lib/page.ts";
import { StatusPill, Thumb, Where } from "../components/ThingCard.tsx";
import { Icon } from "../ui/Icon.tsx";
import { BlockedHint } from "../components/SendToBurrow.tsx";

const QUICK_KINDS = ["thing", "electronics", "tool", "appliance", "container", "furniture", "room"];
const MAX_CHIPS = 9;
const LAST_PLACE = "burrow.add.lastPlace";

function storedPlace(): string | null {
  try {
    return localStorage.getItem(LAST_PLACE);
  } catch {
    return null;
  }
}

interface Saved {
  thing: ThingView;
  event: BurrowEvent;
  aiInput: Record<string, unknown>;
}

/**
 * Add a thing. Rules (docs/ideas.md → add flow): saving is always allowed, a
 * name alone is a valid thing; Burrow's guesses are accepted by default and
 * marked violet; gaps go to Needs details.
 */
export function Add() {
  const [params] = useSearchParams();
  const [text, setText] = useState(params.get("name") ?? "");
  // null = use the page title as the name until the person edits it
  const [nameEdit, setName] = useState<string | null>(null);
  const [kind, setKind] = useState("thing");
  const [placeId, setPlaceId] = useState<string | null>(storedPlace);
  const [roams, setRoams] = useState(false);
  const [dupOk, setDupOk] = useState(false);
  const [qty, setQty] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Saved[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const refresh = useRefresh();
  const toast = useToast();
  const undo = useUndo();
  const thingKinds = useThingKinds();
  // Seed kinds first, then your own (most used first), as one-tap chips.
  const chipKinds = [
    ...QUICK_KINDS.map((id) => thingKinds.find((k) => k.id === id)).filter((k) => k !== undefined),
    ...thingKinds.filter((k) => !QUICK_KINDS.includes(k.id)).toSorted((a, b) => b.things - a.things),
  ].slice(0, MAX_CHIPS);
  const kinds = { kinds: thingKinds };

  const url = isUrl(text) ? text.trim() : null;
  const durl = useDebounced(url, 300);
  const preview = useQuery({
    queryKey: ["preview", durl],
    queryFn: () =>
      post<{ preview: Preview | null; error?: string; blocked?: boolean }>("/preview", { url: durl }),
    enabled: Boolean(durl),
    staleTime: Infinity,
    retry: false,
  });
  const page = url && preview.data?.preview ? preview.data.preview : null;
  const { data: placeData } = useQuery({
    queryKey: ["places"],
    queryFn: () => get<{ places: Place[] }>("/places"),
  });
  const places = placeData?.places ?? [];
  // Duplicate check while you type: an exact name you already have.
  const dname = useDebounced(url ? "" : text.trim(), 250);
  const dupHits = useQuery({
    queryKey: ["search", dname, 5],
    queryFn: () => get<Hits>(`/search?q=${encodeURIComponent(dname)}&limit=5`),
    enabled: dname.length > 1,
  });

  const name = nameEdit ?? page?.title ?? "";

  useEffect(() => {
    try {
      if (placeId) localStorage.setItem(LAST_PLACE, placeId);
      else localStorage.removeItem(LAST_PLACE);
    } catch {
      // private mode: no memory of the last place, that's fine
    }
  }, [placeId]);

  const finalName = (url ? name : text).trim();
  const canSave = finalName.length > 0 && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const data: Record<string, unknown> = {};
      const sources: Record<string, string> = {};
      if (url) {
        data.url = url;
        sources.url = "you";
      }
      if (page) {
        // The shop's title is kept as the product name even when you call it something else.
        for (const [k, v] of Object.entries(pageData(page))) {
          data[k] = v;
          sources[k] = "page";
        }
        if (page.title && page.title === finalName) sources.name = "page";
      }
      if (qty.trim()) data.quantity = Number(qty);
      const r = await post<{ thing: ThingView; event: BurrowEvent }>("/things", {
        name: finalName,
        kind,
        parentId: roams ? null : placeId,
        ...(roams ? { roams: true } : {}),
        data,
        source: "you",
        sources,
      });
      // The shop's picture becomes a "product" asset, downloaded so it never breaks (D-015).
      if (page?.image)
        await post(`/things/${r.thing.id}/assets/from-url`, { url: page.image, role: "product" }).catch(
          (e: Error) => toast({ text: `Couldn't keep the shop picture: ${e.message}`, error: true }),
        );
      if (photo)
        await upload(`/things/${r.thing.id}/assets`, photo, { role: "photo", filename: photo.name }).catch(
          (e: Error) => toast({ text: `Photo not saved: ${e.message}`, error: true }),
        );
      const aiInput = pageAiInput(finalName, url, page);
      setSaved((s) => [{ thing: r.thing, event: r.event, aiInput }, ...s].slice(0, 20));
      setText("");
      setName(null);
      setQty("");
      setPhoto(null);
      setDupOk(false);
      await refresh();
      inputRef.current?.focus();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setSaving(false);
    }
  }

  const last = saved[0];
  const dup = !url && dupHits.data?.hits.map((h) => h.thing).find((t) => sameName(t.name, finalName));
  const roomChips = [
    ...new Map(
      [
        ...(placeId && !roams ? [places.find((p) => p.id === placeId)] : []),
        ...saved.map((x) => places.find((p) => p.id === x.thing.parentId)),
        ...places.filter((p) => p.depth === 0),
      ]
        .filter((p): p is Place => Boolean(p))
        .map((p) => [p.id, p]),
    ).values(),
  ].slice(0, 7);

  return (
    <main className="page wide">
      <div className="add-cols">
        <form
          className="panel stack add-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div>
            <h1 style={{ fontSize: 32 }}>Add a thing</h1>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              A name is enough. Or paste a shop link, or take a photo.
            </p>
          </div>

          <div className="add-input">
            <label className="field grow">
              <span>Name or link</span>
              <input
                ref={inputRef}
                className="input"
                autoFocus
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setDupOk(false);
                }}
                placeholder="metal calipers · https://www.ikea.com/…"
                autoComplete="off"
                enterKeyHint="done"
              />
            </label>
            <label className={`btn add-photo${photo ? " has" : ""}`}>
              <Icon name="camera" size={20} />
              {photo ? "1 photo" : "Photo"}
              <input
                key={photo ? "has" : "none"}
                className="sr-only"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          {dup && !dupOk && (
            <div className="callout row">
              <span className="grow">
                <b style={{ display: "block", color: "var(--ink)" }}>You already have {dup.name}</b>
                <span className="small">
                  {dup.id} · {dup.kind}
                  {dup.path.length
                    ? ` · ${dup.path.map((p) => p.name).join(" › ")}`
                    : dup.roams
                      ? " · no fixed place"
                      : ""}
                </span>
              </span>
              <Link className="btn small" to={`/t/${dup.id}`}>
                Open it
              </Link>
              <button type="button" className="btn small ghost" onClick={() => setDupOk(true)}>
                It’s a second one
              </button>
            </div>
          )}

          {url && (
            <div className="callout add-page">
              {page?.image ? (
                <img className="thumb" src={page.image} alt="" />
              ) : (
                <span className="thumb" aria-hidden="true">
                  <Icon name="link" />
                </span>
              )}
              <div className="stack grow" style={{ gap: 6 }}>
                {preview.isFetching && <span className="muted">Reading the page…</span>}
                {!preview.isFetching && !page && (
                  <span className="muted">
                    Couldn’t read that page{preview.data?.error ? ` (${preview.data.error})` : ""}. Type a
                    name below.
                  </span>
                )}
                {!preview.isFetching && preview.data?.blocked && (
                  <BlockedHint onRetry={() => void preview.refetch()} />
                )}
                {page && (
                  <>
                    <span className="small" style={{ fontWeight: 600, color: "var(--ink)" }}>
                      Read from {page.siteName ?? "the page"}
                      <span className="muted" style={{ fontWeight: 400 }}>
                        {" "}
                        · free · no AI · one Undo for all of it
                      </span>
                    </span>
                    <span className="small">
                      {[page.brand, page.price].filter(Boolean).join(" · ")}
                      {page.description ? ` · ${page.description.slice(0, 160)}` : ""}
                    </span>
                  </>
                )}
                <label className="field">
                  <span>Name</span>
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="What you call it at home"
                  />
                </label>
              </div>
            </div>
          )}

          <div className="field">
            <span>Where does it live?</span>
            <div className="row" style={{ gap: 6 }}>
              {roomChips.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="chip"
                  aria-pressed={!roams && placeId === p.id}
                  onClick={() => {
                    setPlaceId(p.id);
                    setRoams(false);
                  }}
                  title={p.path}
                >
                  {p.name}
                </button>
              ))}
              <button
                type="button"
                className="chip dashed"
                aria-pressed={roams}
                onClick={() => {
                  setRoams(!roams);
                  setPlaceId(null);
                }}
              >
                <Icon name="bag" size={14} />
                No fixed place
              </button>
              <button
                type="button"
                className="chip dashed"
                aria-pressed={!roams && !placeId}
                onClick={() => {
                  setRoams(false);
                  setPlaceId(null);
                }}
              >
                Not sure yet
              </button>
            </div>
            <PlacePicker
              label=""
              value={roams ? null : placeId}
              onChange={(id) => {
                setPlaceId(id);
                setRoams(false);
              }}
            />
            <span className="small muted">
              {roams
                ? "It travels: no place to keep track of, and it won’t show up in Tidy up."
                : "Remembered for the next add. The spot (shelf, drawer) can follow later."}
            </span>
          </div>

          <div className="add-two">
            <div className="field">
              <span>Kind · optional, AI guesses it</span>
              <div className="row" style={{ gap: 6 }}>
                {chipKinds.map(({ id: k }) => (
                  <button
                    key={k}
                    type="button"
                    className="chip mini"
                    aria-pressed={kind === k}
                    onClick={() => setKind(k)}
                  >
                    {kinds?.kinds.find((x) => x.id === k)?.name ?? k}
                  </button>
                ))}
                <select
                  className="input"
                  style={{ width: "auto", minHeight: 30, padding: "0 8px" }}
                  aria-label="Other kind"
                  value={chipKinds.some((c) => c.id === kind) ? "" : kind}
                  onChange={(e) => e.target.value && setKind(e.target.value)}
                >
                  <option value="">Other…</option>
                  {kinds?.kinds
                    .filter((k) => !chipKinds.some((c) => c.id === k.id))
                    .map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <div className="field">
              <span>How many</span>
              <span className="stepper">
                <button
                  type="button"
                  aria-label="One less"
                  onClick={() => setQty(String(Math.max(1, Number(qty || 1) - 1)))}
                >
                  −
                </button>
                <input
                  inputMode="numeric"
                  aria-label="How many"
                  value={qty}
                  placeholder="1"
                  onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))}
                />
                <button
                  type="button"
                  aria-label="One more"
                  onClick={() => setQty(String(Number(qty || 1) + 1))}
                >
                  +
                </button>
              </span>
            </div>
          </div>

          <div className="row" style={{ borderTop: "1px solid var(--line-3)", paddingTop: 16 }}>
            <button type="submit" className="btn main big" disabled={!canSave}>
              {saving
                ? "Saving…"
                : dup && !dupOk
                  ? "Save anyway"
                  : page
                    ? "Save with what the page says"
                    : "Save"}
            </button>
            <span className="muted small">
              Enter saves · it gets an ID now · local AI fills the rest in violet
            </span>
          </div>
        </form>

        <aside className="stack add-side">
          <h2 className="eyebrow">Just saved</h2>
          {last ? (
            <JustSaved key={last.thing.id} saved={last} onUndo={() => undo.mutate(last.event.seq)} />
          ) : (
            <div className="empty small">Nothing yet. Save one and it shows here while AI fills it in.</div>
          )}
          {saved.length > 1 && (
            <>
              <h2 className="eyebrow">This session</h2>
              <div className="rows">
                {saved.slice(1).map((x) => (
                  <div
                    className="activity row"
                    key={x.thing.id}
                    style={{ flexDirection: "row", flexWrap: "nowrap" }}
                  >
                    <Link
                      to={`/t/${x.thing.id}`}
                      className="grow"
                      style={{ fontWeight: 600, color: "var(--ink)" }}
                    >
                      {x.thing.name}
                    </Link>
                    <span className="idtext">{x.thing.id}</span>
                    <button type="button" className="btn small" onClick={() => undo.mutate(x.event.seq)}>
                      Undo
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          <Link to="/tidy" className="small">
            Tidy up: gaps left for later →
          </Link>
        </aside>
      </div>
    </main>
  );
}

/** Names that are the same thing to a person: case, spaces and apostrophes don't count. */
function sameName(a: string, b: string) {
  return norm(a) === norm(b) && norm(b).length > 1;
}
const norm = (s: string) => s.toLowerCase().replace(/[’'`]/g, "").replace(/\s+/g, " ").trim();

function JustSaved({ saved, onUndo }: { saved: Saved; onUndo: () => void }) {
  const { data } = useQuery({
    queryKey: ["thing", saved.thing.id],
    queryFn: () => get<ThingDetail>(`/things/${saved.thing.id}`),
  });
  const t = data?.thing ?? saved.thing;
  return (
    <section className="panel stack" aria-label="Just saved">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="pill ok">
          <Icon name="check" size={14} stroke={2.4} />
          Saved as {t.id}
        </span>
        <div className="row">
          <Link className="btn small" to={`/t/${t.id}`}>
            Open
          </Link>
          <button type="button" className="btn small" onClick={onUndo}>
            {t.archivedAt ? "Redo" : "Undo"}
          </button>
        </div>
      </div>
      <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
        <Thumb thing={t} />
        <div className="stack grow" style={{ gap: 6 }}>
          <strong style={{ fontSize: 20, fontFamily: "var(--font-display)" }}>{t.name}</strong>
          <Where thing={t} compact />
          <StatusPill thing={t} />
          {t.archivedAt && <span className="muted">Undone — it’s archived.</span>}
        </div>
      </div>
      {!t.archivedAt && (
        <>
          <AiSuggest thingId={t.id} input={saved.aiInput} onApplied={() => {}} />
          <TagEditor thing={t} />
          {data && <Facts thing={t} fields={data.fields} />}
          {t.gaps.length > 0 && (
            <div className="row small">
              <span className="muted">Left for later:</span>
              {t.gaps.map((g) => (
                <span key={g} className="chip dashed" style={{ minHeight: 26 }}>
                  {g}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
