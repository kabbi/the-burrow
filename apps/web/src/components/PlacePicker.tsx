import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, post, type Place, type ThingView } from "../lib/api.ts";
import { useRefresh } from "../lib/hooks.ts";

/**
 * Pick where a thing lives. Type to filter by any part of the path; the last
 * option creates a new place (inside the highlighted one if you pick "inside").
 */
export function PlacePicker({
  value,
  onChange,
  label = "Where",
  autoFocus,
}: {
  value: string | null;
  onChange: (id: string | null, place?: Place) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const refresh = useRefresh();
  const { data } = useQuery({ queryKey: ["places"], queryFn: () => get<{ places: Place[] }>("/places") });
  const places = useMemo(() => data?.places ?? [], [data]);
  const current = places.find((p) => p.id === value) ?? null;
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);

  const matches = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return places.filter((p) => words.every((w) => p.path.toLowerCase().includes(w))).slice(0, 30);
  }, [q, places]);

  const parentForNew = current;
  const options: { key: string; label: string; hint?: string; run: () => void }[] = matches.map((p) => ({
    key: p.id,
    label: p.name,
    hint: p.path.split(" › ").slice(0, -1).join(" › "),
    run: () => pick(p),
  }));
  if (q.trim())
    options.push({
      key: "new",
      label: `+ New place “${q.trim()}”`,
      hint: parentForNew ? `inside ${parentForNew.path}` : "as a room",
      run: () => void create(),
    });

  function pick(p: Place | null) {
    onChange(p?.id ?? null, p ?? undefined);
    setQ("");
    setOpen(false);
  }

  async function create() {
    const name = q.trim();
    const r = await post<{ thing: ThingView }>("/things", {
      name,
      kind: parentForNew ? "container" : "room",
      parentId: parentForNew?.id ?? null,
    });
    await refresh();
    pick({
      id: r.thing.id,
      name,
      kind: r.thing.kind,
      path: parentForNew ? `${parentForNew.path} › ${name}` : name,
      depth: 0,
    });
  }

  return (
    <div className="field">
      <span id={`${id}-l`}>{label}</span>
      <div className="combo">
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input
            id={id}
            role="combobox"
            aria-labelledby={`${id}-l`}
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            className="input"
            autoFocus={autoFocus}
            placeholder={current ? current.path : "Type a room, shelf, box…"}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              setHi(0);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((h) => Math.min(h + 1, options.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((h) => Math.max(h - 1, 0));
              } else if (e.key === "Enter" && open && options[hi]) {
                e.preventDefault();
                e.stopPropagation();
                options[hi]!.run();
              } else if (e.key === "Escape") setOpen(false);
            }}
          />
          {current && (
            <button type="button" className="btn small" onClick={() => pick(null)} aria-label="Clear place">
              ×
            </button>
          )}
        </div>
        {open && options.length > 0 && (
          <ul className="combo-list" role="listbox" id={`${id}-list`}>
            {options.map((o, i) => (
              <li
                key={o.key}
                role="option"
                aria-selected={i === hi}
                onMouseMove={() => i !== hi && setHi(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  o.run();
                }}
              >
                <span>{o.label}</span>
                {o.hint && <span className="muted">{o.hint}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
