import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, patch, post, type Kind, type ThingView } from "../lib/api.ts";
import { useAction } from "../lib/hooks.ts";

const LABELS: Record<string, string> = {
  name: "Name",
  kind: "Kind",
  description: "Description",
  tags: "Tags",
  quantity: "Quantity",
  maker: "Maker",
  model: "Model",
  serial: "Serial no.",
  price: "Price",
  url: "Link",
  notes: "Notes",
  purchaseDate: "Bought on",
};
const HIDDEN = new Set(["imageUrl", "thumbUrl"]);
const SOURCE_LABEL: Record<string, string> = {
  you: "you",
  ai: "AI guess",
  page: "from the page",
  homebox: "HomeBox",
  paperless: "paperless",
  file: "from the file",
  import: "import",
};

function show(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * Every fact Burrow holds about a thing, with where it came from. AI guesses
 * are violet until a person confirms them; "Wrong" clears a guess. Click a
 * value to edit it (then it's yours).
 */
export function Facts({ thing, showEmpty = [] }: { thing: ThingView; showEmpty?: string[] }) {
  const act = useAction();
  const { data: kinds } = useQuery({ queryKey: ["kinds"], queryFn: () => get<{ kinds: Kind[] }>("/kinds") });
  const kind = kinds?.kinds.find((k) => k.id === thing.kind);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const keys = [
    "name",
    "kind",
    ...Object.keys(thing.data).filter((k) => !HIDDEN.has(k)),
    ...showEmpty.filter((k) => thing.data[k] === undefined),
  ];
  const value = (k: string) =>
    k === "name" ? thing.name : k === "kind" ? (kind?.name ?? thing.kind) : thing.data[k];
  const label = (k: string) =>
    LABELS[k] ?? kind?.fields.find((f) => f.key === k)?.label ?? k.replace(/^hb_/, "").replace(/_/g, " ");

  async function save(k: string) {
    setEditing(null);
    const raw = draft.trim();
    const old = value(k);
    let v: unknown = raw;
    if (Array.isArray(old) || k === "tags")
      v = raw
        ? raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : null;
    else if (typeof old === "number" || k === "quantity" || k === "price")
      v = raw === "" ? null : Number(raw);
    if (show(old) === show(v)) return;
    const body = k === "name" ? { name: raw } : { data: { [k]: v } };
    await act(() => patch(`/things/${thing.id}`, body), `${label(k)} updated`);
  }

  async function wrong(k: string) {
    await act(
      () => patch(`/things/${thing.id}`, { data: { [k]: null } }),
      `Removed the guessed ${label(k).toLowerCase()}`,
    );
  }

  async function right(k: string) {
    await act(() => post(`/things/${thing.id}/confirm`, { fields: [k] }), `${label(k)} confirmed`);
  }

  return (
    <div className="facts">
      {keys.map((k) => {
        const m = thing.meta[k];
        const isAi = m?.source === "ai" && !m.confirmed;
        const v = value(k);
        return (
          <div key={k} className={`fact${isAi ? " ai" : ""}`}>
            <span className="label">{label(k)}</span>
            {editing === k ? (
              <input
                className="input"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => save(k)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save(k);
                  if (e.key === "Escape") setEditing(null);
                }}
                aria-label={label(k)}
              />
            ) : k === "kind" ? (
              <KindSelect thing={thing} kinds={kinds?.kinds ?? []} />
            ) : (
              <button
                type="button"
                className="value factvalue"
                onClick={() => {
                  setDraft(show(v));
                  setEditing(k);
                }}
                title={
                  m
                    ? `from ${SOURCE_LABEL[m.source] ?? m.source}${m.confirmed ? ", confirmed" : ""}`
                    : "click to edit"
                }
              >
                {show(v) || <span className="muted">— add</span>}
                {k === "url" && typeof v === "string" && (
                  <>
                    {" "}
                    <a href={v} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                      open
                    </a>
                  </>
                )}
              </button>
            )}
            <span className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
              {isAi && k !== "name" && k !== "kind" ? (
                <>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => right(k)}
                    aria-label={`${label(k)} is right`}
                  >
                    Right
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => wrong(k)}
                    aria-label={`${label(k)} is wrong`}
                  >
                    Wrong
                  </button>
                </>
              ) : isAi ? (
                <button type="button" className="btn small" onClick={() => right(k)}>
                  Right
                </button>
              ) : (
                m && <span className="muted small">{SOURCE_LABEL[m.source] ?? m.source}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function KindSelect({ thing, kinds }: { thing: ThingView; kinds: Kind[] }) {
  const act = useAction();
  return (
    <select
      className="input"
      value={thing.kind}
      aria-label="Kind"
      style={{ maxWidth: 260 }}
      onChange={(e) => act(() => patch(`/things/${thing.id}`, { kind: e.target.value }), "Kind changed")}
    >
      {kinds.map((k) => (
        <option key={k.id} value={k.id}>
          {k.name}
        </option>
      ))}
    </select>
  );
}
