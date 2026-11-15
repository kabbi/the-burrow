import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { post, type AssetView, type Preview, type ThingView } from "../lib/api.ts";
import { useDebounced, useRefresh } from "../lib/hooks.ts";
import { useToast } from "../lib/toast.tsx";
import { aiInput, isUrl, pageData } from "../lib/page.ts";
import { AiSuggest } from "./AiSuggest.tsx";
import { SOURCE_LABEL } from "./Facts.tsx";

const LABEL: Record<string, string> = {
  productName: "Product name",
  maker: "Maker",
  price: "Price",
  currency: "Currency",
};

const isEmpty = (v: unknown) => v === undefined || v === null || v === "";

interface Row {
  key: string;
  from: unknown;
  to: string | number;
  /** Who set the current value, if anyone. */
  source: string | null;
  yours: boolean;
}

/**
 * "Add product link" for a thing that already exists (D-023): read the page (free, no AI),
 * show what would change field by field, apply the chosen values in one go (one Undo), then
 * optionally let the AI fill the rest. The thing's own name is never touched: the shop's
 * title goes to "Product name".
 */
export function LinkEnrich({
  thing,
  assets,
  initialUrl,
  onClose,
}: {
  thing: ThingView;
  /** The thing's assets when known (thing page), to spot a shop picture we already have. */
  assets?: AssetView[];
  initialUrl?: string;
  onClose: () => void;
}) {
  const current = typeof thing.data.url === "string" ? thing.data.url : "";
  const [text, setText] = useState(initialUrl ?? current);
  const url = isUrl(text) ? text.trim() : null;
  const durl = useDebounced(url, 300);
  const preview = useQuery({
    queryKey: ["preview", durl],
    queryFn: () => post<{ preview: Preview | null; error?: string }>("/preview", { url: durl }),
    enabled: Boolean(durl),
    staleTime: Infinity,
    retry: false,
  });
  const reading = Boolean(url) && (url !== durl || preview.isFetching);
  const page = url && !reading && preview.data?.preview ? preview.data.preview : null;

  const rows: Row[] = page
    ? Object.entries(pageData(page)).flatMap(([key, to]) => {
        const from = thing.data[key];
        if (!isEmpty(from) && String(from) === String(to)) return [];
        const m = thing.meta[key];
        const yours = !isEmpty(from) && (m?.source === "you" || Boolean(m?.confirmed));
        return [{ key, from, to, source: isEmpty(from) ? null : (m?.source ?? null), yours }];
      })
    : [];
  // Unchecked = skip. Default: take everything except values a person set or confirmed.
  const [skip, setSkip] = useState<Record<string, boolean>>({});
  const skipped = (r: Row) => skip[r.key] ?? r.yours;

  const haveIt = Boolean(page?.image && assets?.some((a) => a.data.url === page.image && !a.removedAt));
  const coverIsWeak = !thing.cover || !["photo", "product"].includes(thing.cover.role);
  const [picture, setPicture] = useState<boolean | null>(null);
  const [cover, setCover] = useState<boolean | null>(null);
  const [withAi, setWithAi] = useState(true);
  const takePicture = Boolean(page?.image) && (picture ?? !haveIt);
  const makeCover = takePicture && (cover ?? coverIsWeak);

  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ ai: Record<string, unknown> | null } | null>(null);
  const refresh = useRefresh();
  const toast = useToast();

  const linkChanges = url !== null && url !== current;
  const chosen = rows.filter((r) => !skipped(r));
  const count = chosen.length + (linkChanges ? 1 : 0) + (takePicture ? 1 : 0);

  async function apply() {
    if (!url) return;
    setSaving(true);
    try {
      const r = await post<{ thing: ThingView; events: number[]; pictureError: string | null }>(
        `/things/${thing.id}/from-page`,
        {
          url,
          data: Object.fromEntries(chosen.map((x) => [x.key, x.to])),
          ...(takePicture && page?.image ? { picture: page.image, cover: makeCover } : {}),
        },
      );
      await refresh();
      const site = page?.siteName ?? new URL(url).hostname;
      const seqs = r.events;
      toast({
        text: seqs.length ? `Filled ${thing.name} from ${site}` : "Nothing new on that page",
        ...(seqs.length
          ? {
              action: {
                label: "Undo",
                run: async () => {
                  for (const s of seqs.toReversed()) await post(`/events/${s}/undo`);
                  await refresh();
                },
              },
            }
          : {}),
      });
      if (r.pictureError) toast({ text: `Couldn't keep the shop picture: ${r.pictureError}`, error: true });
      if (withAi) setDone({ ai: aiInput(thing.name, url, page) });
      else onClose();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setSaving(false);
    }
  }

  if (done?.ai)
    return (
      <div className="enrich stack">
        <AiSuggest thingId={thing.id} input={done.ai} keep={["name"]} autoStart onApplied={() => {}} />
        <div className="row">
          <button type="button" className="btn small ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );

  return (
    <form
      className="enrich stack"
      onSubmit={(e) => {
        e.preventDefault();
        void apply();
      }}
    >
      <label className="field">
        <span>Product page</span>
        <input
          className="input"
          autoFocus={!initialUrl}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
          placeholder="https://www.ikea.com/…"
          inputMode="url"
          autoComplete="off"
        />
      </label>

      {url && reading && <span className="muted small">Reading the page…</span>}
      {url && !reading && !page && (
        <span className="muted small">
          Couldn’t read that page{preview.data?.error ? ` (${preview.data.error})` : ""}. The link can still
          be saved.
        </span>
      )}
      {page && (
        <div className="row" style={{ alignItems: "flex-start", gap: 12, flexWrap: "nowrap" }}>
          {page.image ? (
            <img className="thumb" src={page.image} alt="" />
          ) : (
            <span className="thumb" aria-hidden="true">
              ↗
            </span>
          )}
          <div className="stack" style={{ gap: 4, minWidth: 0 }}>
            <strong>{page.title ?? page.siteName}</strong>
            <span className="muted small">
              {page.siteName}
              {page.price ? ` · ${page.price}` : ""}
              {page.brand ? ` · ${page.brand}` : ""}
            </span>
            {page.description && <span className="small">{page.description.slice(0, 220)}</span>}
          </div>
        </div>
      )}

      {url && !reading && (
        <div className="changes">
          {linkChanges && (
            <div className="change">
              <input type="checkbox" checked disabled aria-label="Link" />
              <span className="label">Link</span>
              <span className={`from${current ? "" : " none"}`}>{current ? <s>{current}</s> : "—"}</span>
              <span className="to">{url}</span>
            </div>
          )}
          {rows.map((r) => (
            <label key={r.key} className={`change${skipped(r) ? " off" : ""}`}>
              <input
                type="checkbox"
                checked={!skipped(r)}
                onChange={(e) => setSkip((s) => ({ ...s, [r.key]: !e.target.checked }))}
              />
              <span className="label">{LABEL[r.key] ?? r.key}</span>
              <span className={`from${isEmpty(r.from) ? " none" : ""}`}>
                {isEmpty(r.from) ? (
                  "—"
                ) : (
                  <>
                    {String(r.from)}{" "}
                    <span className={r.source === "ai" ? "ai-src" : "muted"}>
                      ({r.yours ? "yours" : (SOURCE_LABEL[r.source ?? ""] ?? r.source)})
                    </span>
                  </>
                )}
              </span>
              <span className="to">{String(r.to)}</span>
            </label>
          ))}
          {page?.image && (
            <label className={`change${takePicture ? "" : " off"}`}>
              <input type="checkbox" checked={takePicture} onChange={(e) => setPicture(e.target.checked)} />
              <span className="label">Shop picture</span>
              <span className={`from${haveIt ? "" : " none"}`}>{haveIt ? "already kept" : "—"}</span>
              <span className="to">add as a product picture</span>
            </label>
          )}
          {takePicture && (
            <label className={`change sub${makeCover ? "" : " off"}`}>
              <input type="checkbox" checked={makeCover} onChange={(e) => setCover(e.target.checked)} />
              <span className="label" />
              <span className="from" />
              <span className="to">
                make it the cover
                {thing.cover ? (coverIsWeak ? ` (now: ${thing.cover.role})` : " (replaces your photo)") : ""}
              </span>
            </label>
          )}
          <label className={`change${withAi ? "" : " off"}`}>
            <input type="checkbox" checked={withAi} onChange={(e) => setWithAi(e.target.checked)} />
            <span className="label">Then</span>
            <span className="from" />
            <span className="to">let the AI fill the rest (description, kind, tags)</span>
          </label>
          {page && rows.length > 0 && (
            <p className="muted small" style={{ margin: "6px 0 0" }}>
              “{thing.name}” stays the name; the shop’s title is kept as the product name.
            </p>
          )}
        </div>
      )}

      <div className="row">
        <button type="submit" className="btn main" disabled={!url || reading || saving}>
          {saving
            ? "Saving…"
            : !page
              ? "Save link"
              : count
                ? `Apply ${count} ${count === 1 ? "change" : "changes"}`
                : "Apply"}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
