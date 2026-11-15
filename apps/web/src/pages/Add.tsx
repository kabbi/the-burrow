import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  get,
  post,
  upload,
  type BurrowEvent,
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
import { PathView, StatusLine, Thumb } from "../components/ThingCard.tsx";
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
        parentId: placeId,
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
      await refresh();
      inputRef.current?.focus();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setSaving(false);
    }
  }

  const last = saved[0];
  return (
    <main className="page">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ fontSize: 34 }}>Add a thing</h1>
        <Link to="/later" className="small">
          Needs details →
        </Link>
      </div>

      <form
        className="panel stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span>What is it? A name is enough — or paste a product link</span>
          <input
            ref={inputRef}
            className="input"
            style={{ fontSize: 20, minHeight: 56 }}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="metal calipers · https://www.ikea.com/…"
            autoComplete="off"
          />
        </label>

        {url && (
          <div className="card" style={{ background: "var(--tint)" }}>
            {page?.image ? (
              <img className="thumb" src={page.image} alt="" />
            ) : (
              <span className="thumb" aria-hidden="true">
                ↗
              </span>
            )}
            <div className="body">
              {preview.isFetching && <span className="muted">Reading the page…</span>}
              {!preview.isFetching && !page && (
                <span className="muted">
                  Couldn’t read that page{preview.data?.error ? ` (${preview.data.error})` : ""}. Type a name
                  below.
                </span>
              )}
              {!preview.isFetching && preview.data?.blocked && (
                <BlockedHint onRetry={() => void preview.refetch()} />
              )}
              {page && (
                <>
                  <span className="muted small">
                    {page.siteName}
                    {page.price ? ` · ${page.price}` : ""}
                    {page.brand ? ` · ${page.brand}` : ""}
                  </span>
                  {page.description && <span className="small">{page.description.slice(0, 220)}</span>}
                </>
              )}
              <label className="field">
                <span>Name</span>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name for this thing"
                />
              </label>
            </div>
          </div>
        )}

        <div className="grid2">
          <PlacePicker value={placeId} onChange={(id) => setPlaceId(id)} />
          <label className="field">
            <span>How many (optional)</span>
            <input
              className="input"
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="1"
            />
          </label>
        </div>

        <label className="field">
          <span>Photo (optional) — on a phone this opens the camera</span>
          <input
            key={photo ? "has" : "none"}
            className="input"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
          />
        </label>

        <div className="field">
          <span>Kind</span>
          <div className="row">
            {chipKinds.map(({ id: k }) => (
              <button
                key={k}
                type="button"
                className="chip"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
              >
                {kinds?.kinds.find((x) => x.id === k)?.name ?? k}
              </button>
            ))}
            <select
              className="input"
              style={{ width: "auto", minHeight: 34 }}
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

        <div className="row">
          <button type="submit" className="btn main" disabled={!canSave}>
            {saving ? "Saving…" : "Save (Enter)"}
          </button>
          <span className="muted small">Saved right away with an ID. Fill the rest now or later.</span>
        </div>
      </form>

      {last && <JustSaved key={last.thing.id} saved={last} onUndo={() => undo.mutate(last.event.seq)} />}

      {saved.length > 1 && (
        <section className="panel flat">
          <h2 className="eyebrow" style={{ margin: "12px 0 6px" }}>
            Added this session
          </h2>
          <div className="list">
            {saved.slice(1).map((s) => (
              <div className="list-row" key={s.thing.id}>
                <Link to={`/t/${s.thing.id}`} style={{ flex: 1, fontWeight: 600, color: "inherit" }}>
                  {s.thing.name}
                </Link>
                <span className="idbadge">{s.thing.id}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function JustSaved({ saved, onUndo }: { saved: Saved; onUndo: () => void }) {
  const { data } = useQuery({
    queryKey: ["thing", saved.thing.id],
    queryFn: () => get<ThingDetail>(`/things/${saved.thing.id}`),
  });
  const t = data?.thing ?? saved.thing;
  return (
    <section className="panel stack" aria-label="Just saved">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="eyebrow" style={{ color: "var(--ok)" }}>
          Saved · {t.id}
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
          <StatusLine thing={t} />
          <PathView thing={t} compact />
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
