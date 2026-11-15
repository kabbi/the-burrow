import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, patch, post, type KindField, type ThingView } from "../lib/api.ts";
import { useAction } from "../lib/hooks.ts";
import { useSchema } from "../lib/schema.ts";
import { ThingSearch } from "./ThingSearch.tsx";

const HIDDEN = new Set(["imageUrl", "thumbUrl", "tags"]);
const SOURCE_LABEL: Record<string, string> = {
  you: "you",
  ai: "AI guess",
  page: "from the page",
  homebox: "HomeBox",
  paperless: "paperless",
  file: "from the file",
  import: "import",
  icons: "icon set",
  app: "from an app (see history)",
};

function show(v: unknown, f?: KindField): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (f?.unit) return `${String(v)} ${f.unit}`;
  return String(v);
}

/** Turn what was typed into the field's value type (validation happens on the server). */
function parseInput(raw: string, f: KindField | undefined, old: unknown): unknown {
  const t = raw.trim();
  if (t === "") return null;
  const type = f?.type ?? (typeof old === "number" ? "number" : Array.isArray(old) ? "list" : "text");
  if (type === "number" || type === "money") return Number(t.replace(",", "."));
  if (type === "list")
    return t
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return t;
}

/**
 * Every fact Burrow holds about a thing: the kind's declared fields (empty ones
 * too, so they're easy to fill), then any extra fields. Provenance on the right;
 * AI guesses are violet until confirmed. Click a value to edit it.
 */
export function Facts({ thing, fields }: { thing: ThingView; fields: KindField[] }) {
  const act = useAction();
  const { data: schema } = useSchema();
  const kind = schema?.kinds.find((k) => k.id === thing.kind);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const declared = new Map(fields.map((f) => [f.key, f]));
  const extra = Object.keys(thing.data).filter((k) => !declared.has(k) && !HIDDEN.has(k));
  const label = (k: string) => declared.get(k)?.label ?? k.replace(/^hb_/, "").replace(/_/g, " ");

  async function save(key: string, value: unknown) {
    setEditing(null);
    const old = key === "name" ? thing.name : thing.data[key];
    if (JSON.stringify(old ?? null) === JSON.stringify(value ?? null)) return;
    const body = key === "name" ? { name: String(value ?? "") } : { data: { [key]: value } };
    await act(() => patch(`/things/${thing.id}`, body), `${key === "name" ? "Name" : label(key)} saved`);
  }

  function editor(key: string, f: KindField | undefined, v: unknown) {
    if (f?.type === "ref")
      return (
        <ThingSearch
          autoFocus
          placeholder={`Find a ${f.refKind ?? "thing"}…`}
          onPick={(t) => void save(key, t.id)}
        />
      );
    const commit = () => save(key, key === "name" ? draft : parseInput(draft, f, v));
    if (f?.type === "longtext")
      return (
        <textarea
          className="input"
          autoFocus
          rows={4}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void commit();
            if (e.key === "Escape") setEditing(null);
          }}
          aria-label={label(key)}
        />
      );
    return (
      <input
        className="input"
        autoFocus
        type={f?.type === "date" ? "date" : f?.type === "number" || f?.type === "money" ? "number" : "text"}
        step="any"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") setEditing(null);
        }}
        aria-label={key === "name" ? "Name" : label(key)}
      />
    );
  }

  function display(key: string, f: KindField | undefined, v: unknown, title: string) {
    const empty = v === undefined || v === null || v === "";
    if (f?.type === "boolean")
      return (
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={v === true} onChange={(e) => void save(key, e.target.checked)} />
          {v === undefined ? <span className="muted">not set</span> : v ? "yes" : "no"}
        </label>
      );
    if (f?.type === "select")
      return (
        <select
          className="input"
          style={{ maxWidth: 280 }}
          value={typeof v === "string" ? v : ""}
          onChange={(e) => void save(key, e.target.value || null)}
          aria-label={label(key)}
        >
          <option value="">—</option>
          {f.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    if (f?.type === "ref" && typeof v === "string")
      return (
        <span className="row" style={{ gap: 8 }}>
          <RefName id={v} />
          <button type="button" className="linkbtn small" onClick={() => setEditing(key)}>
            change
          </button>
        </span>
      );
    return (
      <button
        type="button"
        className="factvalue"
        onClick={() => {
          setDraft(Array.isArray(v) ? v.join(", ") : empty ? "" : String(v));
          setEditing(key);
        }}
        title={title}
      >
        {empty ? <span className="muted">— add</span> : show(v, f)}
        {f?.type === "url" && typeof v === "string" && (
          <>
            {" "}
            <a href={v} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              open
            </a>
          </>
        )}
      </button>
    );
  }

  const row = (key: string, f: KindField | undefined) => {
    const m = thing.meta[key];
    const isAi = m?.source === "ai" && !m.confirmed;
    const v = key === "name" ? thing.name : thing.data[key];
    const empty = v === undefined || v === null || v === "";
    const title = m
      ? `from ${SOURCE_LABEL[m.source] ?? m.source}${m.confirmed ? ", confirmed" : ""}`
      : "click to edit";
    return (
      <div key={key} className={`fact${isAi ? " ai" : ""}`}>
        <span className="label">
          {key === "name" ? "Name" : label(key)}
          {f?.wanted && empty && (
            <span className="tag" style={{ marginLeft: 6 }}>
              wanted
            </span>
          )}
        </span>
        <span className="value">{editing === key ? editor(key, f, v) : display(key, f, v, title)}</span>
        <span className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
          {isAi ? (
            <>
              <button
                type="button"
                className="btn small"
                onClick={() =>
                  act(() => post(`/things/${thing.id}/confirm`, { fields: [key] }), `${label(key)} confirmed`)
                }
              >
                Right
              </button>
              {key !== "name" && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    act(
                      () => patch(`/things/${thing.id}`, { data: { [key]: null } }),
                      `Removed the guessed ${label(key)}`,
                    )
                  }
                >
                  Wrong
                </button>
              )}
            </>
          ) : (
            m && !empty && <span className="muted small">{SOURCE_LABEL[m.source] ?? m.source}</span>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="facts">
      {row("name", undefined)}
      <div className="fact">
        <span className="label">Kind</span>
        <span className="value">
          <select
            className="input"
            value={thing.kind}
            aria-label="Kind"
            style={{ maxWidth: 280 }}
            onChange={(e) =>
              act(() => patch(`/things/${thing.id}`, { kind: e.target.value }), "Kind changed")
            }
          >
            {schema?.kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </span>
        <span className="muted small">
          {kind?.parent
            ? `extends ${schema?.kinds.find((k) => k.id === kind.parent)?.name ?? kind.parent}`
            : ""}
        </span>
      </div>
      {fields.map((f) => row(f.key, f))}
      {extra.map((k) => row(k, undefined))}
      {adding ? (
        <AddField
          onDone={async (key, value) => {
            setAdding(false);
            if (key) await save(key, value);
          }}
        />
      ) : (
        <div className="fact">
          <button type="button" className="linkbtn small" onClick={() => setAdding(true)}>
            + extra field
          </button>
          <span className="muted small" style={{ gridColumn: "2 / -1" }}>
            Just for this thing. For every {kind?.name.toLowerCase() ?? "thing"}, add it to the kind in{" "}
            <Link to={`/schema?kind=${thing.kind}`}>Schema</Link>.
          </span>
        </div>
      )}
    </div>
  );
}

function AddField({ onDone }: { onDone: (key: string | null, value: unknown) => void }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  // "pot size" → "potSize"
  const cleanKey = key
    .trim()
    .replace(/\s+(\w)/g, (_, c: string) => c.toUpperCase())
    .replace(/[^\w]/g, "");
  return (
    <form
      className="fact"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(cleanKey || null, value.trim() || null);
      }}
    >
      <input
        className="input"
        autoFocus
        placeholder="field name"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        aria-label="Field name"
      />
      <input
        className="input"
        placeholder="value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Field value"
      />
      <span className="row" style={{ gap: 4 }}>
        <button type="submit" className="btn small">
          Add
        </button>
        <button type="button" className="btn small" onClick={() => onDone(null, null)} aria-label="Cancel">
          ×
        </button>
      </span>
    </form>
  );
}

function RefName({ id }: { id: string }) {
  const { data } = useQuery({
    queryKey: ["thing", id],
    queryFn: () => get<{ thing: ThingView }>(`/things/${id}`),
  });
  return <Link to={`/t/${id}`}>{data?.thing.name ?? id}</Link>;
}
