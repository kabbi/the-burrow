import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, post, type BurrowEvent, type Hits, type Overview } from "../lib/api.ts";
import { timeAgo, useDebounced, useRefresh, useUndo } from "../lib/hooks.ts";
import { useToast } from "../lib/toast.tsx";
import { ThingCard } from "../components/ThingCard.tsx";

export function Home() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const dq = useDebounced(q.trim(), 120);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setParams(dq ? { q: dq } : {}, { replace: true });
  }, [dq, setParams]);

  const hits = useQuery({
    queryKey: ["search", dq],
    queryFn: () => get<Hits>(`/search?q=${encodeURIComponent(dq)}&limit=30`),
    enabled: dq.length > 0,
    placeholderData: (prev) => prev,
  });

  return (
    <main className="page">
      <h1 style={{ fontSize: 40 }}>Where’s my…</h1>
      <label className="searchbox">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
        <span className="sr-only">Search for a thing</span>
        <input
          ref={input}
          data-search
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQ("")}
          placeholder="calipers, paracetamol, B-0042…"
          autoComplete="off"
        />
        <span className="kbd">Ctrl K</span>
      </label>

      {dq ? <Results q={dq} hits={hits.data?.hits} loading={hits.isFetching} /> : <Dashboard />}
    </main>
  );
}

function Results({ q, hits, loading }: { q: string; hits: Hits["hits"] | undefined; loading: boolean }) {
  if (!hits) return <p className="muted">{loading ? "Looking…" : ""}</p>;
  if (!hits.length)
    return (
      <div className="empty">
        Nothing called “{q}” yet.{" "}
        <Link to={`/add?name=${encodeURIComponent(q)}`} className="btn main" style={{ marginLeft: 8 }}>
          Add “{q}”
        </Link>
      </div>
    );
  return (
    <section className="stack" aria-label="Search results">
      <p className="muted small" style={{ margin: 0 }}>
        {hits.length} found
      </p>
      {hits.map((h) => (
        <ThingCard key={h.thing.id} thing={h.thing} />
      ))}
    </section>
  );
}

function Dashboard() {
  const { data } = useQuery({ queryKey: ["overview"], queryFn: () => get<Overview>("/overview") });
  const refresh = useRefresh();
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);
  if (!data) return null;

  async function sync() {
    setSyncing(true);
    try {
      const r = await post<{ report: { created: number; updated: number; errors: string[] } }>(
        "/homebox/sync",
      );
      toast({
        text: `HomeBox: ${r.report.created} new, ${r.report.updated} updated${r.report.errors.length ? `, ${r.report.errors.length} errors` : ""}`,
      });
      await refresh();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <div className="tiles">
        <Link className="tile" to="/papers">
          <span className="eyebrow">Papers inbox</span>
          <span className="big">{data.papers.inbox ?? "—"}</span>
          <span className="muted small">
            {data.papers.mode === "off"
              ? "paperless not connected"
              : data.papers.inbox === null
                ? "paperless unreachable"
                : data.papers.inbox
                  ? "to file"
                  : "all filed"}
            {data.papers.mode === "mock" && " · mock data"}
          </span>
        </Link>
        <Link className="tile" to="/later">
          <span className="eyebrow">Needs details</span>
          <span className="big">{data.needsDetails}</span>
          <span className="muted small">things saved with gaps · none urgent</span>
        </Link>
        <div className="tile" style={{ cursor: "default" }}>
          <span className="eyebrow">Missing</span>
          <span className="big" style={{ color: data.missing.length ? "var(--bad)" : undefined }}>
            {data.missing.length}
          </span>
          <span className="muted small">
            {data.missing.length
              ? data.missing
                  .slice(0, 2)
                  .map((t) => t.name)
                  .join(", ")
              : "nothing reported missing"}
          </span>
        </div>
        <button type="button" className="tile" onClick={sync} disabled={syncing || !data.homebox.configured}>
          <span className="eyebrow">Library</span>
          <span className="big">{data.stats.things}</span>
          <span className="muted small">
            things in {data.stats.places} places ·{" "}
            {syncing ? "syncing HomeBox…" : data.homebox.configured ? "sync HomeBox" : "HomeBox off"}
          </span>
        </button>
      </div>

      {data.missing.length > 0 && (
        <section className="stack">
          <h2 className="eyebrow">Missing — last seen</h2>
          {data.missing.map((t) => (
            <ThingCard key={t.id} thing={t} />
          ))}
        </section>
      )}

      <RecentMoves moves={data.moves} />

      {data.recentlyAdded.length > 0 && (
        <section className="stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 className="eyebrow">Recently added</h2>
            <Link to="/add" className="small">
              Add a thing
            </Link>
          </div>
          <div className="grid2">
            {data.recentlyAdded.map((t) => (
              <ThingCard key={t.id} thing={t} compact />
            ))}
          </div>
        </section>
      )}

      <p className="muted small">
        AI spend: ${data.ai.monthUsd.toFixed(4)} this month · ${data.ai.totalUsd.toFixed(4)} total (
        {data.ai.runs} runs) · <Link to="/ai">log</Link>
      </p>
    </>
  );
}

function describe(e: BurrowEvent & { undone?: boolean }, names: Map<string, string>): string {
  const b = e.body;
  const n = (id: string | null | undefined) => (id ? (names.get(id) ?? id) : "nowhere");
  switch (b.type) {
    case "thing.moved":
      return `${n(b.from)} → ${n(b.to)}`;
    case "thing.status":
      return b.to === "missing" ? "reported missing" : b.to === "ok" ? "found" : "marked not checked";
    case "thing.created":
      return "added";
    default:
      return b.type;
  }
}

function RecentMoves({ moves }: { moves: (BurrowEvent & { undone?: boolean })[] }) {
  const undo = useUndo();
  const { data } = useQuery({
    queryKey: ["events-named", moves.map((m) => m.seq).join(",")],
    queryFn: () =>
      get<{
        events: {
          seq: number;
          thing: { id: string; name: string; from: string | null; to: string | null } | null;
        }[];
      }>("/events?types=thing.moved,thing.status,thing.created&limit=40"),
  });
  if (!moves.length) return null;
  const info = new Map(data?.events.map((e) => [e.seq, e.thing]) ?? []);
  return (
    <section className="panel flat">
      <h2 className="eyebrow" style={{ margin: "12px 0 6px" }}>
        Recently changed · every change can be undone
      </h2>
      <div className="list">
        {moves.map((e) => {
          const t = info.get(e.seq);
          const names = new Map<string, string>();
          if (e.body.type === "thing.moved") {
            if (e.body.from && t?.from) names.set(e.body.from, t.from);
            if (e.body.to && t?.to) names.set(e.body.to, t.to);
          }
          const id = "id" in e.body ? e.body.id : "";
          return (
            <div className="list-row" key={e.seq}>
              <Link
                to={`/t/${id}`}
                style={{ flex: "1 1 200px", fontWeight: 600, color: "inherit", textDecoration: "none" }}
              >
                {t?.name ?? id}
              </Link>
              <span style={{ flex: "2 1 280px", color: e.undone ? "var(--warn)" : undefined }}>
                {e.undone ? `Undone — ${describe(e, names)}` : describe(e, names)}
              </span>
              <span className="muted small" style={{ flex: "0 1 140px" }}>
                {e.actor === "you" ? "" : `${e.actor} · `}
                {timeAgo(e.at)}
              </span>
              <button type="button" className="btn small" onClick={() => undo.mutate(e.seq)}>
                {e.undone ? "Redo" : "Undo"}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
