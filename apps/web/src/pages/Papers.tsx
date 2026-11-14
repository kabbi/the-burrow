import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  get,
  post,
  type DocDetail,
  type Hits,
  type Named,
  type PaperDoc,
  type Taxonomy,
} from "../lib/api.ts";
import { timeAgo, useDebounced, useRefresh } from "../lib/hooks.ts";
import { useToast } from "../lib/toast.tsx";
import { PlacePicker } from "../components/PlacePicker.tsx";

type Folder =
  | { kind: "inbox" }
  | { kind: "all" }
  | { kind: "type"; id: number }
  | { kind: "tag"; id: number };

function folderKey(f: Folder) {
  return "id" in f ? `${f.kind}:${f.id}` : f.kind;
}

/** Papers = paperless-ngx, metadata only. Burrow never reads document text. */
export function Papers() {
  const [params, setParams] = useSearchParams();
  const [folder, setFolder] = useState<Folder>({ kind: "inbox" });
  const selected = params.get("doc") ? Number(params.get("doc")) : null;
  const select = (id: number | null) => setParams(id ? { doc: String(id) } : {}, { replace: true });

  const status = useQuery({
    queryKey: ["papers-status"],
    queryFn: () => get<{ mode: string; ok: boolean; error?: string }>("/papers/status"),
  });
  const tax = useQuery({
    queryKey: ["papers-tax"],
    queryFn: () => get<Taxonomy>("/papers/taxonomy"),
    enabled: status.data?.ok === true,
  });
  const list = useQuery({
    queryKey: ["papers-list", folderKey(folder)],
    enabled: status.data?.ok === true,
    queryFn: () =>
      folder.kind === "inbox"
        ? get<{ count: number; docs: PaperDoc[] }>("/papers/inbox")
        : get<{ count: number; docs: PaperDoc[] }>(
            `/papers/docs${folder.kind === "type" ? `?type=${folder.id}` : folder.kind === "tag" ? `?tag=${folder.id}` : ""}`,
          ),
  });

  const docs = list.data?.docs;
  useEffect(() => {
    if (!selected && docs?.length) select(docs[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs]);

  if (status.data && !status.data.ok)
    return (
      <main className="page">
        <h1 style={{ fontSize: 34 }}>Papers</h1>
        <div className="empty">
          paperless-ngx is{" "}
          {status.data.mode === "off" ? "not configured" : `unreachable: ${status.data.error ?? ""}`}
        </div>
      </main>
    );

  return (
    <main className="page wide">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ fontSize: 34 }}>Papers</h1>
        <span className="muted small">
          paperless-ngx{status.data?.mode === "mock" ? " (mock data)" : ""} · Burrow reads titles and tags
          only, never the text
        </span>
      </div>
      <div className="papers">
        <nav className="folders" aria-label="Folders">
          <FolderButton
            f={{ kind: "inbox" }}
            cur={folder}
            set={setFolder}
            label="Inbox"
            n={folder.kind === "inbox" ? list.data?.count : undefined}
          />
          <FolderButton f={{ kind: "all" }} cur={folder} set={setFolder} label="All papers" />
          {tax.data && (
            <>
              <h3>Types</h3>
              {tax.data.documentTypes.map((t) => (
                <FolderButton
                  key={t.id}
                  f={{ kind: "type", id: t.id }}
                  cur={folder}
                  set={setFolder}
                  label={t.name}
                  n={t.document_count}
                />
              ))}
              <h3>Tags</h3>
              {tax.data.tags
                .filter((t) => (t.document_count ?? 0) > 0)
                .map((t) => (
                  <FolderButton
                    key={t.id}
                    f={{ kind: "tag", id: t.id }}
                    cur={folder}
                    set={setFolder}
                    label={t.name}
                    n={t.document_count}
                  />
                ))}
            </>
          )}
        </nav>

        <section className="doclist stack" style={{ gap: 2 }} aria-label="Documents">
          {docs?.length === 0 && (
            <div className="empty">
              {folder.kind === "inbox" ? "Inbox zero. Everything is filed." : "Nothing here."}
            </div>
          )}
          {docs?.map((d) => (
            <button key={d.id} type="button" aria-pressed={selected === d.id} onClick={() => select(d.id)}>
              <strong>{d.title}</strong>
              <span className="muted small">
                {timeAgo(d.added)} · {d.page_count ?? "?"} p{d.why ? ` · ${d.why}` : ""}
                {d.correspondentName ? ` · ${d.correspondentName}` : ""}
              </span>
              {d.things.length > 0 && (
                <span className="small">↳ {d.things.map((t) => t.name).join(", ")}</span>
              )}
            </button>
          ))}
        </section>

        <section>
          {selected && tax.data ? (
            <DocPanel
              key={selected}
              id={selected}
              tax={tax.data}
              onFiled={() => {
                const i = docs?.findIndex((d) => d.id === selected) ?? -1;
                const nextDoc = folder.kind === "inbox" ? docs?.[i + 1] : undefined;
                select(nextDoc?.id ?? null);
              }}
            />
          ) : (
            <div className="empty">Pick a paper.</div>
          )}
        </section>
      </div>
    </main>
  );
}

function FolderButton({
  f,
  cur,
  set,
  label,
  n,
}: {
  f: Folder;
  cur: Folder;
  set: (f: Folder) => void;
  label: string;
  n?: number | undefined;
}) {
  return (
    <button type="button" aria-pressed={folderKey(f) === folderKey(cur)} onClick={() => set(f)}>
      <span>{label}</span>
      {n !== undefined && <span className="small">{n}</span>}
    </button>
  );
}

function DocPanel({ id, tax, onFiled }: { id: number; tax: Taxonomy; onFiled: () => void }) {
  const { data } = useQuery({ queryKey: ["paper", id], queryFn: () => get<DocDetail>(`/papers/docs/${id}`) });
  const refresh = useRefresh();
  const toast = useToast();
  const [title, setTitle] = useState<string | null>(null);
  const [corr, setCorr] = useState<number | null | undefined>(undefined);
  const [type, setType] = useState<number | null | undefined>(undefined);
  const [tags, setTags] = useState<number[] | null>(null);
  const [things, setThings] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Initial values: what paperless already has, else its own suggestions (violet).
  const s = data?.suggestions;
  const d = data?.doc;
  const sugCorr = d && !d.correspondent ? (s?.correspondents[0] ?? null) : null;
  const sugType = d && !d.document_type ? (s?.document_types[0] ?? null) : null;
  const curCorr = corr !== undefined ? corr : (d?.correspondent ?? sugCorr);
  const curType = type !== undefined ? type : (d?.document_type ?? sugType);
  const inbox = useMemo(() => data?.inboxTagIds ?? [], [data]);
  const baseTags = useMemo(() => {
    if (!d) return [];
    const set = new Set(d.tags.filter((t) => !inbox.includes(t)));
    for (const t of s?.tags ?? []) if (!inbox.includes(t)) set.add(t);
    return [...set];
  }, [d, s, inbox]);
  const curTags = tags ?? baseTags;
  const curThings = things ?? d?.things ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void file();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!data || !d) return <div className="panel muted">Loading…</div>;
  const aiTag = (t: number) => !d.tags.includes(t) && (s?.tags ?? []).includes(t);

  async function file() {
    if (busy) return;
    setBusy(true);
    try {
      await post(`/papers/docs/${id}/file`, {
        ...(title !== null ? { title } : {}),
        correspondent: curCorr ?? null,
        document_type: curType ?? null,
        tags: curTags,
        thingIds: curThings.filter((t) => !d!.things.some((x) => x.id === t.id)).map((t) => t.id),
        done: true,
      });
      toast({ text: `Filed “${title ?? d!.title}”` });
      await refresh();
      onFiled();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack">
      <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
        <a href={data.webUrl} target="_blank" rel="noreferrer" title="Open in paperless">
          <img
            className="docthumb"
            src={`/api/papers/docs/${id}/thumb`}
            alt={`First page of ${d.title}`}
            style={{ width: 150 }}
          />
        </a>
        <div className="stack grow" style={{ gap: 8 }}>
          <label className="field">
            <span>Title</span>
            <input className="input" value={title ?? d.title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <span className="muted small">
            added {timeAgo(d.added)} · {d.page_count ?? "?"} pages · {d.original_file_name}
          </span>
          {s && (
            <span className="small" style={{ color: "var(--ai-ink)" }}>
              ● violet = paperless’ own suggestion (its classifier, nothing leaves your server)
            </span>
          )}
        </div>
      </div>

      <div className="grid2">
        <NamedSelect
          label="From"
          list={tax.correspondents}
          value={curCorr ?? null}
          ai={corr === undefined && !d.correspondent && sugCorr !== null}
          onChange={setCorr}
        />
        <NamedSelect
          label="Type"
          list={tax.documentTypes}
          value={curType ?? null}
          ai={type === undefined && !d.document_type && sugType !== null}
          onChange={setType}
        />
      </div>

      <div className="field">
        <span>Tags</span>
        <div className="row">
          {curTags.map((t) => (
            <button
              key={t}
              type="button"
              className={`chip${aiTag(t) && tags === null ? " ai" : ""}`}
              onClick={() => setTags(curTags.filter((x) => x !== t))}
              title="Remove"
            >
              {tax.tags.find((x) => x.id === t)?.name ?? `#${t}`} ×
            </button>
          ))}
          <select
            className="input"
            style={{ width: "auto", minHeight: 34 }}
            value=""
            aria-label="Add tag"
            onChange={(e) => e.target.value && setTags([...curTags, Number(e.target.value)])}
          >
            <option value="">+ tag</option>
            {tax.tags
              .filter((t) => !curTags.includes(t.id) && !inbox.includes(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </div>
      </div>

      <div className="field">
        <span>Belongs to (receipt of, manual for, …)</span>
        <div className="row">
          {curThings.map((t) => (
            <span key={t.id} className="chip" aria-pressed="true">
              <Link to={`/t/${t.id}`} style={{ color: "inherit" }}>
                {t.name}
              </Link>
              {!d.things.some((x) => x.id === t.id) && (
                <button
                  type="button"
                  className="linkbtn"
                  style={{ color: "#fff" }}
                  aria-label={`Unlink ${t.name}`}
                  onClick={() => setThings(curThings.filter((x) => x.id !== t.id))}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {data.guesses
            .filter((g) => !curThings.some((t) => t.id === g.id))
            .map((g) => (
              <button
                key={g.id}
                type="button"
                className="chip dashed"
                onClick={() => setThings([...curThings, { id: g.id, name: g.name }])}
              >
                + {g.name}
              </button>
            ))}
        </div>
        <ThingFinder onPick={(t) => !curThings.some((x) => x.id === t.id) && setThings([...curThings, t])} />
      </div>

      <PlacePicker
        label="Paper copy is in (binder, drawer…) — leave empty if there's no paper copy"
        value={data.entity?.parentId ?? null}
        onChange={async (placeId) => {
          try {
            await post(`/papers/docs/${id}/place`, { placeId });
            toast({ text: placeId ? "Paper copy location saved" : "Marked as no paper copy" });
            await refresh();
          } catch (e) {
            toast({ text: (e as Error).message, error: true });
          }
        }}
      />

      <div className="row">
        <button type="button" className="btn main" onClick={file} disabled={busy}>
          {busy ? "Filing…" : "File it (Ctrl+Enter)"}
        </button>
        <a className="btn ghost" href={data.webUrl} target="_blank" rel="noreferrer">
          Open in paperless
        </a>
      </div>
    </div>
  );
}

function NamedSelect({
  label,
  list,
  value,
  ai,
  onChange,
}: {
  label: string;
  list: Named[];
  value: number | null;
  ai: boolean;
  onChange: (v: number | null) => void;
}) {
  return (
    <label className="field">
      <span>
        {label} {ai && <span className="tag ai">suggested</span>}
      </span>
      <select
        className="input"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        style={
          ai ? { borderColor: "var(--ai)", color: "var(--ai-ink)", background: "var(--ai-tint)" } : undefined
        }
      >
        <option value="">—</option>
        {list.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ThingFinder({ onPick }: { onPick: (t: { id: string; name: string }) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 150);
  const { data } = useQuery({
    queryKey: ["search", dq],
    queryFn: () => get<Hits>(`/search?q=${encodeURIComponent(dq)}&limit=6`),
    enabled: dq.length > 1,
  });
  return (
    <div className="combo">
      <input
        className="input"
        placeholder="Search things to link…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search things to link"
      />
      {dq.length > 1 && data && data.hits.length > 0 && (
        <ul className="combo-list" role="listbox">
          {data.hits.map((h) => (
            <li
              key={h.thing.id}
              role="option"
              aria-selected="false"
              onMouseDown={(e) => {
                e.preventDefault();
                onPick({ id: h.thing.id, name: h.thing.name });
                setQ("");
              }}
            >
              <span>{h.thing.name}</span>
              <span className="muted">{h.thing.path.map((p) => p.name).join(" › ")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
