import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, post, type TagInfo } from "../lib/api.ts";
import { useAction } from "../lib/hooks.ts";

/** All tags as a tree with usage counts. Tags are things: each opens its own page. */
export function TagsPage() {
  const { data } = useQuery({ queryKey: ["tags"], queryFn: () => get<{ tags: TagInfo[] }>("/tags") });
  const act = useAction();
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
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

  const tree = (parent: string | null) => {
    const kids = tags.filter((t) => t.parentId === parent && visible.has(t.id));
    if (!kids.length) return null;
    return (
      <ul className="tree">
        {kids.map((t) => (
          <li key={t.id}>
            <span className="row" style={{ gap: 8 }}>
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
        <span className="muted small">{tags.length} tags · nest them from a tag’s page</span>
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
      <section className="panel">{tree(null) ?? <p className="muted">No tags match.</p>}</section>
    </main>
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
