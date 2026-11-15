import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { post, type KindField, type Schema as SchemaT, type SchemaKind } from "../lib/api.ts";
import { useRefresh } from "../lib/hooks.ts";
import { useSchema } from "../lib/schema.ts";
import { useToast } from "../lib/toast.tsx";

const FIELD_TYPES: { id: KindField["type"]; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "longtext", label: "Long text" },
  { id: "number", label: "Number" },
  { id: "money", label: "Money" },
  { id: "date", label: "Date" },
  { id: "boolean", label: "Yes / no" },
  { id: "url", label: "Link" },
  { id: "select", label: "Choice" },
  { id: "list", label: "List" },
  { id: "ref", label: "Another thing" },
];

/** Kinds, their fields and relation types: all data, all undoable via history (D-012). */
export function Schema() {
  const { data } = useSchema();
  const [params, setParams] = useSearchParams();
  const selected = params.get("kind");
  const [tab, setTab] = useState<"kinds" | "relations">(
    params.get("tab") === "relations" ? "relations" : "kinds",
  );
  if (!data) return <main className="page" />;
  const kind = data.kinds.find((k) => k.id === selected);

  return (
    <main className="page wide">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ fontSize: 32 }}>Kinds &amp; fields</h1>
        <div className="row">
          <button
            type="button"
            className="chip"
            aria-pressed={tab === "kinds"}
            onClick={() => setTab("kinds")}
          >
            Kinds · {data.kinds.length}
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={tab === "relations"}
            onClick={() => setTab("relations")}
          >
            Link types · {data.relations.length}
          </button>
        </div>
      </div>
      {tab === "kinds" ? (
        <div className="dbgrid">
          <nav className="folders" aria-label="Kinds">
            {kindTree(data.kinds).map(({ k, depth }) => (
              <button
                key={k.id}
                type="button"
                aria-pressed={k.id === selected}
                onClick={() => setParams({ kind: k.id }, { replace: true })}
                style={{ paddingLeft: 10 + depth * 16 }}
              >
                <span>{k.name}</span>
                <span className="small">{k.things}</span>
              </button>
            ))}
            <button
              type="button"
              aria-pressed={selected === "new"}
              onClick={() => setParams({ kind: "new" }, { replace: true })}
            >
              <span>+ New kind</span>
            </button>
          </nav>
          <section>
            {selected === "new" ? (
              <KindEditor
                key="new"
                schema={data}
                onSaved={(id) => setParams({ kind: id }, { replace: true })}
              />
            ) : kind ? (
              <KindEditor key={kind.id} schema={data} kind={kind} onSaved={() => {}} />
            ) : (
              <div className="empty">
                Pick a kind, or make a new one. A kind is a template: its fields show up on every thing of
                that kind, and kinds can extend each other.
              </div>
            )}
          </section>
        </div>
      ) : (
        <Relations schema={data} />
      )}
    </main>
  );
}

function kindTree(kinds: SchemaKind[]) {
  const out: { k: SchemaKind; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const k of kinds
      .filter((x) => (x.parent ?? null) === parent)
      .toSorted((a, b) => a.name.localeCompare(b.name))) {
      out.push({ k, depth });
      walk(k.id, depth + 1);
    }
  };
  walk(null, 0);
  // orphans (parent missing) at the end
  for (const k of kinds) if (!out.some((o) => o.k.id === k.id)) out.push({ k, depth: 0 });
  return out;
}

function slug(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function fieldKey(label: string) {
  const words = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const key = words
    .map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join("");
  return /^[a-zA-Z]/.test(key) ? key : `f${key}`;
}

function KindEditor({
  schema,
  kind,
  onSaved,
}: {
  schema: SchemaT;
  kind?: SchemaKind;
  onSaved: (id: string) => void;
}) {
  const refresh = useRefresh();
  const toast = useToast();
  const [name, setName] = useState(kind?.name ?? "");
  const [parent, setParent] = useState<string | null>(kind ? kind.parent : "thing");
  const [isPlace, setIsPlace] = useState(kind?.isPlace ?? false);
  const [physical, setPhysical] = useState(kind?.physical ?? true);
  const [fields, setFields] = useState<KindField[]>(kind?.fields ?? []);
  const [busy, setBusy] = useState(false);
  const id = kind?.id ?? slug(name);
  const inherited = parent ? (schema.kinds.find((k) => k.id === parent)?.effectiveFields ?? []) : [];

  const set = (i: number, p: Partial<KindField>) =>
    setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...p } : f)));

  async function save() {
    setBusy(true);
    try {
      const clean = fields
        .filter((f) => f.label.trim())
        .map((f) => {
          const out: KindField = { key: f.key || fieldKey(f.label), label: f.label.trim(), type: f.type };
          if (f.type === "select") out.options = (f.options ?? []).map((o) => o.trim()).filter(Boolean);
          if (f.type === "ref" && f.refKind) out.refKind = f.refKind;
          if (f.unit?.trim()) out.unit = f.unit.trim();
          if (f.wanted) out.wanted = true;
          return out;
        });
      await post("/kinds", { id, name: name.trim(), parent, isPlace, physical, fields: clean });
      toast({ text: `Saved kind “${name.trim()}”` });
      await refresh();
      onSaved(id);
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack">
      <div className="grid2">
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Plant, Film roll, Board game…"
          />
        </label>
        <label className="field">
          <span>Extends (inherits its fields)</span>
          <select className="input" value={parent ?? ""} onChange={(e) => setParent(e.target.value || null)}>
            <option value="">(nothing)</option>
            {schema.kinds
              .filter((k) => k.id !== kind?.id)
              .map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div className="row">
        <span className="mono muted">id: {id || "…"}</span>
        <label className="row small">
          <input type="checkbox" checked={isPlace} onChange={(e) => setIsPlace(e.target.checked)} /> things
          can go inside it (a place)
        </label>
        <label className="row small">
          <input type="checkbox" checked={physical} onChange={(e) => setPhysical(e.target.checked)} />{" "}
          physical (needs a location)
        </label>
        {kind?.builtin && <span className="tag">built in — saving makes it yours</span>}
        {kind && kind.things > 0 && (
          <Link className="small" to={`/workshop/db?t=things&q=${encodeURIComponent(kind.id)}`}>
            {kind.things} things
          </Link>
        )}
      </div>

      {inherited.length > 0 && (
        <p className="muted small" style={{ margin: 0 }}>
          Inherited: {inherited.map((f) => f.label).join(", ")}
        </p>
      )}

      <div className="stack" style={{ gap: 8 }}>
        <span className="eyebrow">Fields</span>
        {fields.map((f, i) => (
          <div key={i} className="fieldrow">
            <input
              className="input"
              value={f.label}
              placeholder="Label"
              aria-label="Field label"
              onChange={(e) => set(i, { label: e.target.value })}
            />
            <select
              className="input"
              value={f.type}
              aria-label="Field type"
              onChange={(e) => set(i, { type: e.target.value as KindField["type"] })}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            {f.type === "select" ? (
              <input
                className="input"
                placeholder="choices, comma separated"
                aria-label="Choices"
                value={(f.options ?? []).join(", ")}
                onChange={(e) => set(i, { options: e.target.value.split(",").map((s) => s.trimStart()) })}
              />
            ) : f.type === "ref" ? (
              <select
                className="input"
                value={f.refKind ?? ""}
                aria-label="Points to kind"
                onChange={(e) => set(i, { refKind: e.target.value || undefined })}
              >
                <option value="">any thing</option>
                {schema.kinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            ) : f.type === "number" || f.type === "money" ? (
              <input
                className="input"
                placeholder="unit (mm, W, €)"
                aria-label="Unit"
                value={f.unit ?? ""}
                onChange={(e) => set(i, { unit: e.target.value })}
              />
            ) : (
              <span />
            )}
            <span className="mono muted small">{f.key || (f.label ? fieldKey(f.label) : "")}</span>
            <label className="row small" title="Missing values show up in Needs details">
              <input
                type="checkbox"
                checked={Boolean(f.wanted)}
                onChange={(e) => set(i, { wanted: e.target.checked })}
              />{" "}
              wanted
            </label>
            <button
              type="button"
              className="btn small"
              aria-label={`Remove field ${f.label}`}
              onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="linkbtn small"
          style={{ alignSelf: "flex-start" }}
          onClick={() => setFields((fs) => [...fs, { key: "", label: "", type: "text" }])}
        >
          + field
        </button>
      </div>
      <div className="row">
        <button type="button" className="btn main" disabled={busy || !name.trim() || !id} onClick={save}>
          {busy ? "Saving…" : kind ? "Save kind" : "Create kind"}
        </button>
        <span className="muted small">
          Removing a field never deletes values: they stay on things as extra fields.
        </span>
      </div>
    </div>
  );
}

function Relations({ schema }: { schema: SchemaT }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [draft, setDraft] = useState({
    name: "",
    inverse: "",
    toKinds: "",
    cardinality: "many",
    symmetric: false,
  });

  async function create() {
    try {
      const id = slug(draft.name).replace(/-/g, "_");
      await post("/relation-types", {
        id,
        name: draft.name.trim(),
        inverse: (draft.symmetric ? draft.name : draft.inverse).trim(),
        toKinds: draft.toKinds ? [draft.toKinds] : [],
        cardinality: draft.cardinality,
        symmetric: draft.symmetric,
      });
      toast({ text: `Link type “${draft.name}” created` });
      setDraft({ name: "", inverse: "", toKinds: "", cardinality: "many", symmetric: false });
      await refresh();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  }

  const kindName = (id: string) => schema.kinds.find((k) => k.id === id)?.name ?? id;
  return (
    <div className="stack">
      <section className="panel flat">
        <div className="list">
          {schema.relations.map((r) => (
            <div key={r.id} className="list-row">
              <strong style={{ flex: "1 1 180px" }}>{r.name}</strong>
              <span style={{ flex: "1 1 180px" }} className="muted">
                {r.symmetric ? "both ways" : `back: ${r.inverse}`}
              </span>
              <span style={{ flex: "2 1 240px" }} className="small">
                {r.fromKinds.length ? r.fromKinds.map(kindName).join(", ") : "anything"} →{" "}
                {r.toKinds.length ? r.toKinds.map(kindName).join(", ") : "anything"}
                {r.cardinality === "one" ? " · at most one" : ""}
              </span>
              <span className="muted small">{r.links} links</span>
              {r.builtin && <span className="tag">built in</span>}
            </div>
          ))}
        </div>
      </section>
      <section className="panel stack">
        <span className="eyebrow">New link type</span>
        <div className="grid2">
          <label className="field">
            <span>Reads (from → to)</span>
            <input
              className="input"
              placeholder="charger for, belongs to, borrowed from…"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Reads back (to → from)</span>
            <input
              className="input"
              placeholder="chargers, owns, lent to…"
              disabled={draft.symmetric}
              value={draft.symmetric ? draft.name : draft.inverse}
              onChange={(e) => setDraft({ ...draft, inverse: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Links to</span>
            <select
              className="input"
              value={draft.toKinds}
              onChange={(e) => setDraft({ ...draft, toKinds: e.target.value })}
            >
              <option value="">any kind</option>
              {schema.kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>How many</span>
            <select
              className="input"
              value={draft.cardinality}
              onChange={(e) => setDraft({ ...draft, cardinality: e.target.value })}
            >
              <option value="many">many</option>
              <option value="one">at most one</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label className="row small">
            <input
              type="checkbox"
              checked={draft.symmetric}
              onChange={(e) => setDraft({ ...draft, symmetric: e.target.checked })}
            />{" "}
            same both ways (like “related to”)
          </label>
          <button
            type="button"
            className="btn main"
            disabled={!draft.name.trim() || (!draft.symmetric && !draft.inverse.trim())}
            onClick={create}
          >
            Create link type
          </button>
        </div>
      </section>
    </div>
  );
}
