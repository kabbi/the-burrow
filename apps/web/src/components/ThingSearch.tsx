import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type Hits, type ThingView } from "../lib/api.ts";
import { useDebounced } from "../lib/hooks.ts";

/** Type to find a thing; picks call onPick. `filter` hides results (e.g. by kind). */
export function ThingSearch({
  onPick,
  placeholder = "Search things…",
  filter,
  autoFocus,
  label,
}: {
  onPick: (t: ThingView) => void;
  placeholder?: string;
  filter?: (t: ThingView) => boolean;
  autoFocus?: boolean;
  label?: string;
}) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const dq = useDebounced(q.trim(), 150);
  const { data } = useQuery({
    queryKey: ["search", dq],
    queryFn: () => get<Hits>(`/search?q=${encodeURIComponent(dq)}&limit=12`),
    enabled: dq.length > 0,
  });
  const hits = (data?.hits ?? [])
    .map((h) => h.thing)
    .filter((t) => !filter || filter(t))
    .slice(0, 8);
  const pick = (t: ThingView) => {
    onPick(t);
    setQ("");
  };
  return (
    <div className="combo">
      <input
        className="input"
        placeholder={placeholder}
        value={q}
        autoFocus={autoFocus}
        aria-label={label ?? placeholder}
        onChange={(e) => {
          setQ(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => Math.min(h + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter" && hits[hi]) {
            e.preventDefault();
            pick(hits[hi]!);
          } else if (e.key === "Escape") setQ("");
        }}
      />
      {dq && hits.length > 0 && (
        <ul className="combo-list" role="listbox">
          {hits.map((t, i) => (
            <li
              key={t.id}
              role="option"
              aria-selected={i === hi}
              onMouseMove={() => i !== hi && setHi(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(t);
              }}
            >
              <span>{t.name}</span>
              <span className="muted">
                {t.id} · {t.kind}
                {t.path.length ? ` · ${t.path.map((p) => p.name).join(" › ")}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
