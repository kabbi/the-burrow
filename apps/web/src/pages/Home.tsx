import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, type EventRow, type Hits, type Overview, type ThingView } from "../lib/api.ts";
import { timeAgo, useDebounced, useUndo } from "../lib/hooks.ts";
import { useSchema } from "../lib/schema.ts";
import { eventLabel } from "../lib/events.ts";
import { isUrl } from "../lib/page.ts";
import { Icon } from "../ui/Icon.tsx";
import { SecHead } from "../ui/parts.tsx";
import { ThingRow, ThingTile, Thumb } from "../ui/thing.tsx";
import { ThingOfTheDay } from "../components/ThingOfTheDay.tsx";
import { useActors } from "../lib/auth.ts";

/** Find: the home page. One question, one box; below it what needs you and what changed. */
export function Home() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [q, setQ] = useState(params.get("q") ?? "");
  const dq = useDebounced(q.trim(), 120);
  const input = useRef<HTMLInputElement>(null);

  // The top bar's search lands here with ?q=…
  const urlQ = params.get("q") ?? "";
  useEffect(() => {
    if (urlQ !== dq) setQ(urlQ);
    // only when the address changes from outside
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ]);
  useEffect(() => {
    if (dq !== urlQ) setParams(dq ? { q: dq } : {}, { replace: true });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);

  const link = isUrl(q) ? q.trim() : null;
  const hits = useQuery({
    queryKey: ["search", dq, 200],
    queryFn: () => get<Hits>(`/search?q=${encodeURIComponent(dq)}&limit=200`),
    enabled: dq.length > 0 && !link,
    placeholderData: (prev) => prev,
  });

  // Only autofocus with a mouse: on a phone it would throw the keyboard up on every visit.
  const autoFocus = typeof window !== "undefined" && window.matchMedia?.("(hover: hover)").matches;

  return (
    <main className="page">
      <section className="stack" style={{ gap: 14 }}>
        {!dq && <h1 className="question">Where’s my…</h1>}
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (link) navigate(`/add?name=${encodeURIComponent(link)}`);
          }}
        >
          <label className={`searchbox${dq ? " small" : ""}`}>
            <Icon name="search" size={22} />
            <span className="sr-only">Find a thing</span>
            <input
              ref={input}
              data-search
              autoFocus={autoFocus}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQ("")}
              placeholder="calipers, paracetamol, B-0042 — or paste a link to add it"
              autoComplete="off"
              enterKeyHint="search"
            />
            {q ? (
              <button type="button" className="btn ghost small" onClick={() => setQ("")}>
                Clear
              </button>
            ) : (
              <span className="kbd">Ctrl K</span>
            )}
          </label>
        </form>
      </section>

      {link ? (
        <div className="callout row" style={{ justifyContent: "space-between" }}>
          <span>That's a link. Add the thing it shows?</span>
          <Link className="btn main" to={`/add?name=${encodeURIComponent(link)}`}>
            Add from this link
          </Link>
        </div>
      ) : dq ? (
        <Results key={dq} q={dq} hits={hits.data?.hits.map((h) => h.thing)} loading={hits.isFetching} />
      ) : (
        <Dashboard />
      )}
    </main>
  );
}

// ------------------------------------------------------------------ results

/** 12 or more alike things fold into one row so the rest stays visible. */
const GROUP_AT = 12;

const FIELD_WORDS: Record<string, string> = {
  description: "the description",
  productName: "the product name",
  maker: "the maker",
  model: "the model",
  notes: "the notes",
  serial: "the serial number",
};

/** Why a thing matched, when its name doesn't say it: "the description (AI): “…usb-c…”". */
function whyFound(t: ThingView, q: string): string | null {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const has = (s: string) => terms.some((w) => s.toLowerCase().includes(w));
  const all = (s: string) => terms.every((w) => s.toLowerCase().includes(w));
  if (all(t.name)) return null;
  if (/^\s*b?\s*-?\s*\d+\s*$/i.test(q) && t.id.toLowerCase().includes(terms[0]!.replace(/\D/g, "")))
    return "its ID";
  const tag = t.tags.find((x) => has(x.name));
  if (tag) return `the tag ${tag.name}`;
  for (const [k, v] of Object.entries(t.data)) {
    if (typeof v !== "string" || !has(v) || k === "url") continue;
    const w = terms.find((x) => v.toLowerCase().includes(x))!;
    const at = v.toLowerCase().indexOf(w);
    const snip = v.slice(Math.max(0, at - 24), at + w.length + 24).trim();
    const ai = t.meta[k]?.source === "ai" && !t.meta[k]?.confirmed ? " (AI)" : "";
    return `${FIELD_WORDS[k] ?? `the ${k.replace(/_/g, " ")}`}${ai}: “${at > 24 ? "…" : ""}${snip}${at + w.length + 24 < v.length ? "…" : ""}”`;
  }
  const p = t.path.find((x) => has(x.name) || has(x.position ?? ""));
  if (p) return `where it is: ${p.name}`;
  if (t.refs.some((r) => has(r.remoteId))) return "a linked id";
  return null;
}

function whereKey(t: ThingView): string | null {
  if (t.kind === "tag" || t.path[0]?.kind === "tag") return null;
  if (t.path.length) return t.path[0]!.name;
  if (t.roams) return "No fixed place";
  if (t.gaps.includes("where")) return "Not placed yet";
  return null;
}

function Results({ q, hits, loading }: { q: string; hits: ThingView[] | undefined; loading: boolean }) {
  const { data: schema } = useSchema();
  const [where, setWhere] = useState<Set<string>>(new Set());
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [flat, setFlat] = useState(false);

  const facets = useMemo(() => {
    const w = new Map<string, number>();
    const tg = new Map<string, number>();
    for (const t of hits ?? []) {
      const k = whereKey(t);
      if (k) w.set(k, (w.get(k) ?? 0) + 1);
      for (const x of t.tags) tg.set(x.name, (tg.get(x.name) ?? 0) + 1);
    }
    return {
      where: [...w].toSorted((a, b) => b[1] - a[1]),
      tags: [...tg].toSorted((a, b) => b[1] - a[1]).slice(0, 12),
    };
  }, [hits]);

  if (!hits) return <p className="muted">{loading ? "Looking…" : ""}</p>;

  // Tags are things too, but they read better as a line of chips above the results.
  const tagKinds = new Set(schema?.kinds.filter((k) => k.isTag).map((k) => k.id) ?? ["tag"]);
  const tagHits = hits.filter((t) => tagKinds.has(t.kind));
  const shown = hits
    .filter((t) => !tagKinds.has(t.kind))
    .filter(
      (t) =>
        (!where.size || where.has(whereKey(t) ?? "")) && (!tags.size || t.tags.some((x) => tags.has(x.name))),
    );
  const byKind = new Map<string, ThingView[]>();
  for (const t of shown) byKind.set(t.kind, [...(byKind.get(t.kind) ?? []), t]);
  const groups = flat ? [] : [...byKind].filter(([, xs]) => xs.length >= GROUP_AT);
  const grouped = new Set(groups.flatMap(([, xs]) => xs.map((t) => t.id)));
  const singles = shown.filter((t) => !grouped.has(t.id));
  const alone = !singles.length && groups.length === 1;

  return (
    <div className="results">
      {(facets.where.length > 1 || facets.tags.length > 0) && (
        <aside className="facets" aria-label="Narrow down">
          {facets.where.length > 1 && (
            <div className="stack" style={{ gap: 4 }}>
              <h2 className="eyebrow">Where</h2>
              {facets.where.map(([k, n]) => (
                <label key={k} className="facet">
                  <input type="checkbox" checked={where.has(k)} onChange={() => toggle(where, k, setWhere)} />
                  <span className="grow">{k}</span>
                  <span className="idtext">{n}</span>
                </label>
              ))}
            </div>
          )}
          {facets.tags.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <h2 className="eyebrow">Tags</h2>
              <div className="row" style={{ gap: 6 }}>
                {facets.tags.map(([k, n]) => (
                  <button
                    key={k}
                    type="button"
                    className="chip mini"
                    aria-pressed={tags.has(k)}
                    onClick={() => toggle(tags, k, setTags)}
                  >
                    {k} <span className="n">{n}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="small muted facets-note">
            No fixed scopes. When {GROUP_AT} or more alike things match, Burrow folds them into a group so the
            rest stays visible.
          </p>
        </aside>
      )}

      <div className="stack results-main">
        <p className="small muted" style={{ margin: 0 }}>
          {shown.length === hits.length - tagHits.length ? "" : `${shown.length} of `}
          {hits.length - tagHits.length === 1 ? "1 thing" : `${hits.length - tagHits.length} things`}
          {groups.length > 0 &&
            (alone
              ? " · all in one group, so it opens by itself"
              : ` · ${grouped.size} of them folded into ${groups.length === 1 ? "a group" : `${groups.length} groups`}`)}
          {flat && (
            <>
              {" · "}
              <button type="button" className="linkbtn quiet" onClick={() => setFlat(false)}>
                group them again
              </button>
            </>
          )}
        </p>

        {tagHits.length > 0 && (
          <div className="row" style={{ gap: 6 }}>
            <span className="small muted">Tags</span>
            {tagHits.slice(0, 12).map((t) => (
              <Link key={t.id} to={`/t/${t.id}`} className="chip mini">
                <Icon name="tag" size={14} />
                {t.path.length ? `${t.path.map((p) => p.name).join(" › ")} › ` : ""}
                {t.name}
              </Link>
            ))}
          </div>
        )}

        {singles.length > 0 && (
          <div className="rows">
            {singles.slice(0, 60).map((t) => (
              <ThingRow
                key={t.id}
                thing={t}
                why={(() => {
                  const w = whyFound(t, q);
                  return w ? `Found in ${w}` : null;
                })()}
              />
            ))}
          </div>
        )}
        {singles.length > 60 && (
          <p className="small muted">…and {singles.length - 60} more. Type more to narrow it down.</p>
        )}

        {groups.map(([kind, xs]) => {
          const k = schema?.kinds.find((x) => x.id === kind);
          const isOpen = open[kind] ?? alone;
          return (
            <section key={kind} className="rows">
              <div className="trow group-head">
                <span className="stackpic" aria-hidden="true">
                  {xs.slice(0, 3).map((t) => (
                    <Thumb key={t.id} thing={t} />
                  ))}
                </span>
                <div className="main">
                  <div className="name">
                    <span className="tname">{plural(k?.name ?? kind)}</span>
                    <span className="mono">
                      {xs.length}
                      {k ? ` of ${k.things}` : ""} match
                    </span>
                  </div>
                  <div className="small" style={{ color: "var(--ink-2)" }}>
                    {xs
                      .slice(0, 3)
                      .map((t) => t.name)
                      .join(", ")}
                    {xs.length > 3 ? `, +${xs.length - 3} more` : ""}
                  </div>
                  <div className="why row" style={{ gap: 6 }}>
                    <Icon name="group" size={14} />
                    Grouped automatically: {k ? `${k.things} things share` : "they share"} the kind {kind}
                  </div>
                </div>
                <div className="acts">
                  <button
                    type="button"
                    className="btn small"
                    style={{ borderColor: "var(--ink)" }}
                    aria-expanded={isOpen}
                    onClick={() => setOpen((o) => ({ ...o, [kind]: !isOpen }))}
                  >
                    {isOpen ? "Fold" : `Show ${xs.length}`}
                  </button>
                  <button type="button" className="btn small ghost" onClick={() => setFlat(true)}>
                    Don’t group
                  </button>
                </div>
              </div>
              {isOpen && xs.map((t) => <ThingRow key={t.id} thing={t} />)}
            </section>
          );
        })}

        {!hits.length && <div className="empty">Nothing matches “{q}”.</div>}
        <div className="callout row" style={{ justifyContent: "space-between" }}>
          <span>
            {hits.length ? "Not what you meant? " : ""}Add <b>“{q}”</b> as a new thing, or paste a shop link.
          </span>
          <Link className={`btn${hits.length ? "" : " main"}`} to={`/add?name=${encodeURIComponent(q)}`}>
            Add “{q}”
          </Link>
        </div>
      </div>
    </div>
  );
}

function toggle(set: Set<string>, v: string, put: (s: Set<string>) => void) {
  const n = new Set(set);
  if (n.has(v)) n.delete(v);
  else n.add(v);
  put(n);
}

function plural(s: string) {
  const w = s.charAt(0).toUpperCase() + s.slice(1);
  return /s$/i.test(w) ? w : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`;
}

// ------------------------------------------------------------------ dashboard

function Dashboard() {
  const { data } = useQuery({ queryKey: ["overview"], queryFn: () => get<Overview>("/overview") });
  if (!data) return null;
  const jobs: { n: number; title: string; sub: string; to: string; btn: string; ai?: boolean }[] = [];
  if (data.aiChecks.things)
    jobs.push({
      n: data.aiChecks.fields,
      title: `AI guesses waiting on ${data.aiChecks.things === 1 ? "1 thing" : `${data.aiChecks.things} things`}`,
      sub: data.aiChecks.names.join(", ") + (data.aiChecks.things > 3 ? ", …" : ""),
      to: "/tidy#ai",
      btn: "Check them",
      ai: true,
    });
  if (data.papers.inbox)
    jobs.push({
      n: data.papers.inbox,
      title: "Papers in the inbox",
      sub:
        data.papers.mode === "mock" ? "Mock papers (PAPERLESS_MOCK)" : "File them and attach them to things",
      to: "/papers",
      btn: "File papers",
    });
  if (data.places.unplaced)
    jobs.push({
      n: data.places.unplaced,
      title:
        data.places.unplaced === 1
          ? "1 thing isn’t placed yet"
          : `${data.places.unplaced} things aren’t placed yet`,
      sub: "Put them somewhere, or say they have no fixed place",
      to: "/tidy#where",
      btn: "Place them",
    });
  const other = data.needsDetails - data.places.unplaced;
  if (other > 0)
    jobs.push({
      n: other,
      title: "Details worth having",
      sub: "Serial numbers, warranty dates and other wanted fields",
      to: "/tidy#fields",
      btn: "Fill in",
    });

  return (
    <>
      {data.missing.length > 0 && (
        <section className="stack" style={{ gap: 10 }}>
          <SecHead title={`Missing · ${data.missing.length}`} />
          <div className="rows">
            {data.missing.map((t) => (
              <ThingRow key={t.id} thing={t} />
            ))}
          </div>
        </section>
      )}

      <div className="find-cols">
        <div className="stack" style={{ gap: 32, minWidth: 0 }}>
          {jobs.length > 0 && (
            <section className="stack" style={{ gap: 10 }}>
              <SecHead title="When you have a minute">
                <Link to="/tidy">All of Tidy up</Link>
              </SecHead>
              <div className="rows">
                {jobs.map((j) => (
                  <Link key={j.title} to={j.to} className="job">
                    <span className={`ntile${j.ai ? " ai" : ""}`}>{j.n}</span>
                    <span className="main">
                      <span className="title" style={{ display: "block" }}>
                        {j.title}
                      </span>
                      <span className="sub" style={{ display: "block" }}>
                        {j.sub}
                      </span>
                    </span>
                    <span className="job-go">
                      {j.btn}
                      <Icon name="next" size={16} stroke={2.2} />
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {data.recentlyAdded.length > 0 && (
            <section className="stack" style={{ gap: 10 }}>
              <SecHead title="Recently added">
                <span className="small muted">
                  {data.stats.things} things · {data.stats.places} places · {data.stats.tags} tags
                </span>
              </SecHead>
              <div className="tgrid">
                {data.recentlyAdded.map((t) => (
                  <ThingTile key={t.id} thing={t} />
                ))}
              </div>
            </section>
          )}
          <p className="small muted" style={{ margin: 0 }}>
            AI this month: ${data.ai.monthUsd.toFixed(2)} · {data.ai.runs} runs in all ·{" "}
            <Link to="/workshop/ai">AI log</Link>
          </p>
        </div>
        <aside className="stack find-side" style={{ gap: 28 }}>
          <ThingOfTheDay />
          <Activity />
        </aside>
      </div>
    </>
  );
}

/** What changed, one entry per thing: a burst of edits to one thing reads as one line. */
function Activity() {
  const undo = useUndo();
  const { data } = useQuery({
    queryKey: ["events", "home"],
    queryFn: () => get<{ events: EventRow[] }>("/events?limit=60"),
  });
  const actors = useActors();
  const entries = useMemo(() => {
    const out: { id: string; name: string; events: EventRow[] }[] = [];
    for (const e of data?.events ?? []) {
      if (!e.thing) continue;
      const last = out.at(-1);
      const near = last && Date.parse(last.events.at(-1)!.at) - Date.parse(e.at) < 30 * 60_000;
      if (last && last.id === e.thing.id && near) last.events.push(e);
      else out.push({ id: e.thing.id, name: e.thing.name, events: [e] });
    }
    return out.slice(0, 8);
  }, [data]);
  if (!entries.length) return null;
  return (
    <section className="stack" style={{ gap: 10 }}>
      <SecHead title="What changed · per thing" />
      <div className="rows">
        {entries.map((x) => {
          const evs = x.events;
          const allUndone = evs.every((e) => e.undone);
          const undoable = evs.filter((e) => e.undoable && e.undone === allUndone);
          const what = [
            ...new Set(
              evs
                .toReversed()
                .map((e) => eventLabel(e, { from: e.thing?.from ?? null, to: e.thing?.to ?? null })),
            ),
          ].join(" · ");
          const who = [...new Set(evs.map((e) => actors(e.actor).label))].join(" + ");
          return (
            <div key={`${x.id}-${evs[0]!.seq}`} className="activity">
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                <Link
                  to={`/t/${x.id}`}
                  style={{
                    fontWeight: 600,
                    color: "var(--ink)",
                    textDecoration: allUndone ? "line-through" : "none",
                  }}
                >
                  {x.name}
                </Link>
                <span className="small muted" style={{ whiteSpace: "nowrap" }}>
                  {timeAgo(evs[0]!.at)}
                </span>
              </div>
              <div className="small" style={{ color: "var(--ink-2)" }}>
                {allUndone ? "Undone. Everything is back as it was." : what}
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="small muted">{who}</span>
                {undoable.length > 0 && (
                  <button
                    type="button"
                    className={`linkbtn quiet small${allUndone ? "" : " on-hover"}`}
                    onClick={async () => {
                      for (const e of undoable) await undo.mutateAsync(e.seq);
                    }}
                  >
                    {allUndone ? "Redo" : "Undo"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
