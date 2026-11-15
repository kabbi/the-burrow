import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, patch, post, type KindField, type Place, type TidyData, type ThingView } from "../lib/api.ts";
import { useAction, useBulk } from "../lib/hooks.ts";
import { useSchema } from "../lib/schema.ts";
import { isUrl } from "../lib/page.ts";
import { PlacePicker } from "../components/PlacePicker.tsx";
import { LinkEnrich } from "../components/LinkEnrich.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageHead } from "../ui/parts.tsx";
import { Thumb, Where } from "../ui/thing.tsx";

/**
 * Tidy up (was Needs details): nothing here is urgent. Gaps are grouped into jobs, each with
 * one action that clears many at once.
 */
export function Tidy() {
  const { data } = useQuery({ queryKey: ["tidy"], queryFn: () => get<TidyData>("/tidy") });
  const { data: schema } = useSchema();
  const { hash } = useLocation();
  const [open, setOpen] = useState<string | null>(hash.slice(1) || null);

  const jobs = useMemo(() => {
    if (!data) return [];
    const out: Job[] = [];
    const unplaced = data.gaps.filter((t) => t.gaps.includes("where"));
    if (unplaced.length)
      out.push({
        id: "where",
        n: unplaced.length,
        title:
          unplaced.length === 1 ? "1 thing isn’t placed yet" : `${unplaced.length} things aren’t placed yet`,
        sub: "Pick a group, drop it in a box. Laptops and phones can have no fixed place instead.",
        things: unplaced,
      });
    if (data.aiChecks.length) {
      const n = data.aiChecks.reduce((s, x) => s + x.fields.length, 0);
      out.push({
        id: "ai",
        n,
        ai: true,
        title: `AI guesses to check on ${data.aiChecks.length === 1 ? "1 thing" : `${data.aiChecks.length} things`}`,
        sub: `${data.aiChecks
          .slice(0, 3)
          .map((x) => x.thing.name)
          .join(", ")}${data.aiChecks.length > 3 ? ", …" : ""} · Right or Wrong, one thing at a time`,
        things: data.aiChecks.map((x) => x.thing),
      });
    }
    // One job per wanted field ("3 appliances without a serial number").
    const byField = new Map<string, ThingView[]>();
    for (const t of data.gaps)
      for (const g of t.gaps) if (g !== "where") byField.set(g, [...(byField.get(g) ?? []), t]);
    for (const [key, things] of byField) {
      const f = fieldOf(schema?.kinds, things[0]!.kind, key);
      const label = f?.label ?? key;
      out.push({
        id: `field-${key}`,
        n: things.length,
        title: `${things.length === 1 ? "1 thing" : `${things.length} things`} without ${label.toLowerCase()}`,
        sub: `${things
          .slice(0, 3)
          .map((t) => t.name)
          .join(", ")}${things.length > 3 ? ", …" : ""} · type it in, or paste a product link`,
        field: key,
        label,
        type: f?.type ?? "text",
        things,
      });
    }
    return out;
  }, [data, schema]);

  // #fields (from Find) opens the first field job; nothing chosen opens the first job.
  const current = open === "fields" ? (jobs.find((j) => j.field)?.id ?? null) : (open ?? jobs[0]?.id ?? null);

  return (
    <main className="page narrow">
      <PageHead
        title="Tidy up"
        lede="Nothing here is urgent. Gaps are grouped into jobs, each with one action that clears many at once."
      />
      {data && !jobs.length && <div className="empty">All tidy. Nothing is missing a place or a detail.</div>}
      {jobs.map((j) => {
        const isOpen = current === j.id;
        return (
          <section key={j.id} id={j.id} className="rows tidy-job">
            <button
              type="button"
              className="job tidy-head"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? "" : j.id)}
            >
              <span className={`ntile${j.ai ? " ai" : ""}`}>{j.n}</span>
              <span className="main">
                <span className="tname" style={{ display: "block", fontSize: 19 }}>
                  {j.title}
                </span>
                <span className="sub" style={{ display: "block" }}>
                  {j.sub}
                </span>
              </span>
              <Icon name="down" size={20} className={isOpen ? "flip" : ""} />
            </button>
            {isOpen && j.id === "where" && <PlaceJob things={j.things} />}
            {isOpen && j.id === "ai" && data && <AiJob checks={data.aiChecks} />}
            {isOpen && j.field && (
              <FieldJob things={j.things} field={j.field} label={j.label!} type={j.type!} />
            )}
          </section>
        );
      })}
    </main>
  );
}

interface Job {
  id: string;
  n: number;
  title: string;
  sub: string;
  things: ThingView[];
  ai?: boolean;
  field?: string;
  label?: string;
  type?: string;
}

function fieldOf(
  kinds: { id: string; effectiveFields: KindField[] }[] | undefined,
  kind: string,
  key: string,
) {
  return kinds?.find((k) => k.id === kind)?.effectiveFields.find((f) => f.key === key);
}

// ------------------------------------------------------------------ not placed yet

function PlaceJob({ things }: { things: ThingView[] }) {
  const bulk = useBulk();
  const { data: schema } = useSchema();
  const kinds = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of things) m.set(t.kind, (m.get(t.kind) ?? 0) + 1);
    return [...m].toSorted((a, b) => b[1] - a[1]);
  }, [things]);
  const [kind, setKind] = useState<string>(kinds[0]?.[0] ?? "");
  const ofKind = things.filter((t) => t.kind === kind);
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of ofKind) for (const x of t.tags) m.set(x.name, (m.get(x.name) ?? 0) + 1);
    return [...m].toSorted((a, b) => b[1] - a[1]).slice(0, 10);
  }, [ofKind]);
  const [tag, setTag] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [to, setTo] = useState<Place | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);

  const shown = tag ? ofKind.filter((t) => t.tags.some((x) => x.name === tag)) : ofKind;
  const pickTag = (t: string | null) => {
    setTag(t);
    setSel(new Set((t ? ofKind.filter((x) => x.tags.some((y) => y.name === t)) : []).map((x) => x.id)));
  };
  const chosen = things.filter((t) => sel.has(t.id));
  const run = async (body: (t: ThingView) => object, text: string) => {
    setBusy(true);
    await bulk(
      chosen.map((t) => () => post(`/things/${t.id}/move`, body(t))),
      text,
    );
    setSel(new Set());
    setBusy(false);
  };

  return (
    <div className="tidy-body stack">
      {kinds.length > 1 && (
        <div className="row" style={{ gap: 6 }}>
          <span className="small muted">Kind</span>
          {kinds.map(([k, n]) => (
            <button
              key={k}
              type="button"
              className="chip mini"
              aria-pressed={k === kind}
              onClick={() => {
                setKind(k);
                setTag(null);
                setSel(new Set());
              }}
            >
              {schema?.kinds.find((x) => x.id === k)?.name ?? k} <span className="n">{n}</span>
            </button>
          ))}
        </div>
      )}
      {tags.length > 1 && (
        <div className="row" style={{ gap: 6 }}>
          <span className="small muted">Select by tag</span>
          {tags.map(([t, n]) => (
            <button
              key={t}
              type="button"
              className="chip mini"
              aria-pressed={t === tag}
              onClick={() => pickTag(t === tag ? null : t)}
            >
              {t} <span className="n">{n}</span>
            </button>
          ))}
        </div>
      )}
      <div className="pick-grid">
        {shown.slice(0, all ? 400 : 48).map((t) => {
          const on = sel.has(t.id);
          return (
            <label key={t.id} className={`pick${on ? " on" : ""}`}>
              <Thumb thing={t} />
              <span className="row" style={{ gap: 6, flexWrap: "nowrap", alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const n = new Set(sel);
                    if (on) n.delete(t.id);
                    else n.add(t.id);
                    setSel(n);
                  }}
                />
                <span className="small" style={{ fontWeight: 600, lineHeight: 1.25 }}>
                  {t.name}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {shown.length > 48 && !all && (
        <button
          type="button"
          className="linkbtn quiet"
          style={{ alignSelf: "flex-start" }}
          onClick={() => setAll(true)}
        >
          Show all {shown.length} (or pick a tag)
        </button>
      )}
      <div className="row">
        <button
          type="button"
          className="linkbtn quiet"
          onClick={() => setSel(new Set(shown.map((t) => t.id)))}
        >
          Select all {shown.length}
        </button>
        {sel.size > 0 && (
          <button type="button" className="linkbtn quiet" onClick={() => setSel(new Set())}>
            Clear
          </button>
        )}
      </div>
      {sel.size > 0 && (
        <div className="bulkbar">
          <span className="grow" style={{ fontWeight: 600 }}>
            {sel.size} selected
          </span>
          <div className="bulk-pick">
            <PlacePicker label="into" value={to?.id ?? null} onChange={(_id, p) => setTo(p ?? null)} />
          </div>
          <button
            type="button"
            className="btn main"
            disabled={!to || busy}
            onClick={() => to && run(() => ({ to: to.id }), `Put ${sel.size} in ${to.name}`)}
          >
            Put them there
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => run(() => ({ to: null, roams: true }), `${sel.size} now have no fixed place`)}
          >
            <Icon name="bag" size={16} />
            No fixed place
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ AI guesses

function AiJob({ checks }: { checks: TidyData["aiChecks"] }) {
  const act = useAction();
  return (
    <div className="tidy-body stack" style={{ gap: 0, padding: 0 }}>
      {checks.slice(0, 40).map(({ thing: t, fields }) => (
        <div key={t.id} className="trow">
          <Thumb thing={t} />
          <div className="main">
            <div className="name">
              <Link to={`/t/${t.id}`}>{t.name}</Link>
              <span className="idtext">{t.id}</span>
            </div>
            <div className="ai-guesses">
              {fields.map((f) => (
                <span key={f}>
                  <span className="muted">{f === "name" || f === "kind" ? f : f.replace(/_/g, " ")}</span>{" "}
                  <span style={{ color: "var(--ai-ink)" }}>
                    {show(f === "name" ? t.name : f === "kind" ? t.kind : t.data[f])}
                  </span>
                </span>
              ))}
            </div>
          </div>
          <div className="acts">
            <button
              type="button"
              className="btn small ai"
              onClick={() =>
                act(
                  () => post(`/things/${t.id}/confirm`, { fields }),
                  `Confirmed ${fields.length} on ${t.name}`,
                  {
                    group: { key: "tidy-ai", text: (xs) => xs.join(" · ") },
                  },
                )
              }
            >
              <Icon name="check" size={16} stroke={2.6} />
              All right
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function show(v: unknown): string {
  if (v === undefined || v === null) return "—";
  const s = Array.isArray(v) ? v.join(", ") : String(v);
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

// ------------------------------------------------------------------ wanted fields

function FieldJob({
  things,
  field,
  label,
  type,
}: {
  things: ThingView[];
  field: string;
  label: string;
  type: string;
}) {
  return (
    <div className="tidy-body stack" style={{ gap: 0, padding: 0 }}>
      {things.slice(0, 60).map((t) => (
        <FieldRow key={t.id} thing={t} field={field} label={label} type={type} />
      ))}
    </div>
  );
}

/** Types typed here as they are; others (lists, refs, selects) are edited on the thing page. */
const INPUT: Record<string, string> = {
  text: "text",
  longtext: "text",
  url: "url",
  date: "date",
  number: "number",
  money: "number",
};

function FieldRow({
  thing: t,
  field,
  label,
  type,
}: {
  thing: ThingView;
  field: string;
  label: string;
  type: string;
}) {
  const act = useAction();
  const [v, setV] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const hasLink = typeof t.data.url === "string";
  return (
    <div className="trow" style={{ alignItems: "flex-start" }}>
      <Thumb thing={t} />
      <div className="main" style={{ gap: 6 }}>
        <div className="name">
          <Link to={`/t/${t.id}`}>{t.name}</Link>
          <span className="idtext">{t.id}</span>
        </div>
        <Where thing={t} compact />
        {url && <LinkEnrich thing={t} initialUrl={url} onClose={() => setUrl(null)} />}
      </div>
      {!INPUT[type] ? (
        <Link to={`/t/${t.id}`} className="btn small">
          Fill in
        </Link>
      ) : (
        <form
          className="row field-fill"
          onSubmit={(e) => {
            e.preventDefault();
            if (isUrl(v)) {
              setUrl(v.trim());
              setV("");
              return;
            }
            if (!v.trim()) return;
            const value = INPUT[type] === "number" ? Number(v) : v.trim();
            void act(() => patch(`/things/${t.id}`, { data: { [field]: value } }), `${label}: ${v.trim()}`, {
              group: { key: `tidy-${field}`, text: (xs) => xs.join(" · ") },
            });
            setV("");
          }}
        >
          <input
            className="input"
            type={
              isUrl(v)
                ? "text"
                : INPUT[type] === "date"
                  ? "date"
                  : INPUT[type] === "number"
                    ? "number"
                    : "text"
            }
            step="any"
            value={v}
            onChange={(e) => setV(e.target.value)}
            placeholder={hasLink ? label : `${label}, or a product link`}
            aria-label={`${label} for ${t.name}`}
          />
          <button type="submit" className="btn small" disabled={!v.trim()}>
            {isUrl(v) ? "Read link" : "Save"}
          </button>
        </form>
      )}
    </div>
  );
}
