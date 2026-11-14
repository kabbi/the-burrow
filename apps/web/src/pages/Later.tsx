import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type ThingView } from "../lib/api.ts";
import { ThingCard } from "../components/ThingCard.tsx";

/** Things saved with gaps. Nothing here is urgent; it's a to-do you pick at. */
export function Later() {
  const { data } = useQuery({
    queryKey: ["needs-details"],
    queryFn: () => get<{ things: ThingView[] }>("/needs-details"),
  });
  const [gap, setGap] = useState<string | null>(null);
  const things = data?.things ?? [];
  const counts = new Map<string, number>();
  for (const t of things) for (const g of t.gaps) counts.set(g, (counts.get(g) ?? 0) + 1);
  const shown = gap ? things.filter((t) => t.gaps.includes(gap)) : things;
  return (
    <main className="page">
      <div>
        <h1 style={{ fontSize: 34 }}>Needs details</h1>
        <p className="muted" style={{ margin: "6px 0 0" }}>
          {things.length} things saved with gaps · none of this is urgent
        </p>
      </div>
      <div className="row">
        <button type="button" className="chip" aria-pressed={gap === null} onClick={() => setGap(null)}>
          Everything · {things.length}
        </button>
        {[...counts].map(([g, n]) => (
          <button key={g} type="button" className="chip" aria-pressed={gap === g} onClick={() => setGap(g)}>
            {g === "where" ? "No place" : g} · {n}
          </button>
        ))}
      </div>
      {shown.length === 0 && <div className="empty">Nothing missing. Nice.</div>}
      <div className="stack">
        {shown.slice(0, 100).map((t) => (
          <ThingCard key={t.id} thing={t} />
        ))}
      </div>
      {shown.length > 100 && <p className="muted small">…and {shown.length - 100} more</p>}
    </main>
  );
}
