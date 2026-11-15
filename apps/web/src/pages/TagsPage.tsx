import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, post, type TagInfo } from "../lib/api.ts";
import { useAction, useBulk } from "../lib/hooks.ts";

/**
 * All tags as a tree with usage counts. Tags are things: each opens its own page. Tick some to
 * merge them into one, nest them, or archive them, in one go with one Undo.
 */
export function TagsPage() {
  const { data } = useQuery({ queryKey: ["tags"], queryFn: () => get<{ tags: TagInfo[] }>("/tags") });
  const act = useAction();
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const tags = data?.tags ?? [];
  const n = q.trim().toLowerCase();
  const visible = new Set(
    n
      ? tags
          .filter(
            (t) => t.name.toLowerCase().includes(n) || t.aliases.some((a) => a.toLowerCase().includes(n)),
          )
          .flatMap((t) => [t.id, ...ancestors(t, tags)])
      : tags.map((t) => t.id),
  );

  // Unused: nothing tagged and no nested tags.
  const unused = tags.filter((t) => t.uses === 0 && !tags.some((x) => x.parentId === t.id)).map((t) => t.id);

  const tree = (parent: string | null) => {
    const kids = tags.filter((t) => t.parentId === parent && visible.has(t.id));
    if (!kids.length) return null;
    return (
      <ul className="tree">
        {kids.map((t) => (
          <li key={t.id}>
            <span className="row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={sel.has(t.id)}
                aria-label={`Select ${t.name}`}
                onChange={() => {
                  const n = new Set(sel);
                  if (n.has(t.id)) n.delete(t.id);
                  else n.add(t.id);
                  setSel(n);
                }}
              />
              <Link to={`/t/${t.id}`}>{t.name}</Link>
              <span className="muted small">{t.uses}</span>
              {t.aliases.length > 0 && <span className="muted small">also: {t.aliases.join(", ")}</span>}
            </span>
            {tree(t.id)}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <main className="page">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ fontSize: 32 }}>Tags</h1>
        <span className="muted small">{tags.length} tags · tick some to merge, nest or archive them</span>
      </div>
      <div className="row">
        <input
          className="input"
          style={{ maxWidth: 320 }}
          placeholder="Filter tags…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Filter tags"
        />
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void act(
              () => post("/things", { name: name.trim(), kind: "tag" }),
              `Tag “${name.trim()}” created`,
            );
            setName("");
          }}
        >
          <input
            className="input"
            style={{ maxWidth: 220 }}
            placeholder="New tag"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="New tag name"
          />
          <button type="submit" className="btn small">
            Add
          </button>
        </form>
      </div>
      <div className="row">
        {n && (
          <button
            type="button"
            className="linkbtn quiet"
            onClick={() => setSel(new Set(tags.filter((t) => visible.has(t.id)).map((t) => t.id)))}
          >
            Select the {visible.size} shown
          </button>
        )}
        {unused.length > 0 && (
          <button type="button" className="linkbtn quiet" onClick={() => setSel(new Set(unused))}>
            Select the {unused.length} unused
          </button>
        )}
        {sel.size > 0 && (
          <button type="button" className="linkbtn quiet" onClick={() => setSel(new Set())}>
            Clear
          </button>
        )}
      </div>
      <section className="panel">{tree(null) ?? <p className="muted">No tags match.</p>}</section>
      {sel.size > 0 && <TagBulkBar tags={tags} sel={sel} onDone={() => setSel(new Set())} />}
    </main>
  );
}

/** Merge into one / nest under / archive the ticked tags. */
function TagBulkBar({ tags, sel, onDone }: { tags: TagInfo[]; sel: Set<string>; onDone: () => void }) {
  const bulk = useBulk();
  const [busy, setBusy] = useState(false);
  const chosen = tags.filter((t) => sel.has(t.id)).toSorted((a, b) => b.uses - a.uses);
  const [into, setInto] = useState("");
  const target = chosen.find((t) => t.id === into) ?? chosen[0]!;
  const label = (t: TagInfo) => [...t.path, t.name].join(" › ");
  const run = async (fns: Parameters<typeof bulk>[0], text: string) => {
    setBusy(true);
    await bulk(fns, text);
    setBusy(false);
    onDone();
  };
  const n = chosen.length;
  const uses = chosen.reduce((s, t) => s + t.uses, 0);

  return (
    <div className="bulkbar">
      <span className="grow" style={{ fontWeight: 600 }}>
        {n} selected{uses ? ` · used ${uses}×` : ""}
      </span>
      {n > 1 && (
        <>
          <div className="bulk-pick">
            <label className="field">
              <span>Merge into</span>
              <select className="input" value={target.id} onChange={(e) => setInto(e.target.value)}>
                {chosen.map((t) => (
                  <option key={t.id} value={t.id}>
                    {label(t)} ({t.uses})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            className="btn main"
            disabled={busy}
            onClick={() =>
              void run(
                [() => post("/tags/merge", { from: chosen.map((t) => t.id), into: target.id })],
                `Merged ${n} tags into “${target.name}”`,
              )
            }
          >
            Merge
          </button>
        </>
      )}
      <div className="bulk-pick">
        <label className="field">
          <span>Nest under</span>
          <select
            className="input"
            value=""
            disabled={busy}
            onChange={(e) => {
              const to = e.target.value === "-" ? null : e.target.value;
              const where = to ? `under “${tags.find((t) => t.id === to)?.name}”` : "to the top level";
              void run(
                chosen.map((t) => () => post(`/things/${t.id}/move`, { to })),
                `Moved ${n} ${n === 1 ? "tag" : "tags"} ${where}`,
              );
            }}
          >
            <option value="" disabled>
              Pick a tag…
            </option>
            <option value="-">(top level)</option>
            {tags
              .filter((t) => !sel.has(t.id) && !ancestors(t, tags).some((id) => sel.has(id)))
              .toSorted((a, b) => label(a).localeCompare(label(b)))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {label(t)}
                </option>
              ))}
          </select>
        </label>
      </div>
      <button
        type="button"
        className="btn"
        disabled={busy}
        title="Archived tags drop off every thing (Undo brings them back)"
        onClick={() =>
          void run(
            chosen.map((t) => () => post(`/things/${t.id}/archive`)),
            `Archived ${n} ${n === 1 ? "tag" : "tags"}`,
          )
        }
      >
        Archive
      </button>
    </div>
  );
}

function ancestors(t: TagInfo, all: TagInfo[]): string[] {
  const out: string[] = [];
  for (
    let p = all.find((x) => x.id === t.parentId);
    p && out.length < 32;
    p = all.find((x) => x.id === p!.parentId)
  )
    out.push(p.id);
  return out;
}
