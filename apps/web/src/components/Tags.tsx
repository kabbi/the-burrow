import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, post, put, type TagInfo, type ThingView } from "../lib/api.ts";
import { useAction } from "../lib/hooks.ts";

/**
 * A thing's tags as chips. Tags are things (D-013): click one to open it.
 * AI-attached tags are violet with a ✓ to confirm. Type to add (Enter creates).
 */
export function TagEditor({ thing }: { thing: ThingView }) {
  const act = useAction();
  const { data } = useQuery({ queryKey: ["tags"], queryFn: () => get<{ tags: TagInfo[] }>("/tags") });
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  // Tags are sent by ID: two tags can share a name under different parents (PCB › led, led).
  const ids = thing.tags.map((t) => t.id);

  const options = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    const have = new Set(ids);
    const hits = (data?.tags ?? [])
      .filter((t) => !have.has(t.id))
      .filter((t) => t.name.toLowerCase().includes(n) || t.aliases.some((a) => a.toLowerCase().includes(n)))
      .toSorted(
        (a, b) =>
          Number(b.name.toLowerCase().startsWith(n)) - Number(a.name.toLowerCase().startsWith(n)) ||
          b.uses - a.uses,
      )
      .slice(0, 8)
      .map((t) => ({ key: t.id, name: t.name, hint: [...t.path, `${t.uses}×`].join(" › ") }));
    const exact = (data?.tags ?? []).some((t) => t.name.toLowerCase() === n);
    return exact ? hits : [...hits, { key: "new", name: q.trim(), hint: "new tag" }];
  }, [q, data, ids]);
  // A new tag goes by name; for an existing one, its ID.
  const add = (o: { key: string; name: string }) =>
    void setTags([...ids, o.key === "new" ? o.name : o.key], `Tagged “${o.name}”`);

  const setTags = (next: string[], text: string) =>
    act(() => put<{ event?: never }>(`/things/${thing.id}/tags`, { names: next }), text);

  return (
    <div className="row" style={{ alignItems: "flex-start" }}>
      {thing.tags.map((t) => {
        const ai = t.source === "ai";
        return (
          <span key={t.id} className={`chip${ai ? " ai" : ""}`} style={{ minHeight: 30, paddingRight: 4 }}>
            <Link
              to={`/t/${t.id}`}
              style={{ color: "inherit", textDecoration: "none" }}
              title={[...t.path, t.name].join(" › ")}
            >
              {t.path.length > 0 && <span className="muted small">{t.path.at(-1)} › </span>}
              {t.name}
            </Link>
            {ai && (
              <button
                type="button"
                className="tagx"
                aria-label={`${t.name} is right`}
                onClick={() =>
                  act(() => post(`/things/${thing.id}/tags/${t.id}/confirm`), t.name, {
                    group: {
                      key: `tags:${thing.id}`,
                      text: (names) => `Kept ${names.map((n) => `“${n}”`).join(", ")}`,
                    },
                  })
                }
              >
                ✓
              </button>
            )}
            <button
              type="button"
              className="tagx"
              aria-label={`Remove tag ${t.name}`}
              onClick={() =>
                setTags(
                  ids.filter((x) => x !== t.id),
                  `Removed “${t.name}”`,
                )
              }
            >
              ×
            </button>
          </span>
        );
      })}
      <div className="combo" style={{ minWidth: 160, flex: "0 1 220px" }}>
        <input
          className="input"
          style={{ minHeight: 30, borderRadius: 999 }}
          placeholder="+ tag"
          value={q}
          aria-label="Add a tag"
          onChange={(e) => {
            setQ(e.target.value);
            setHi(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHi((h) => Math.min(h + 1, options.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter" && options[hi]) {
              e.preventDefault();
              const o = options[hi]!;
              setQ("");
              add(o);
            } else if (e.key === "Escape") setQ("");
          }}
        />
        {options.length > 0 && (
          <ul className="combo-list" role="listbox">
            {options.map((o, i) => (
              <li
                key={o.key}
                role="option"
                aria-selected={i === hi}
                onMouseMove={() => i !== hi && setHi(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setQ("");
                  add(o);
                }}
              >
                <span>{o.key === "new" ? `+ “${o.name}”` : o.name}</span>
                <span className="muted">{o.hint}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
