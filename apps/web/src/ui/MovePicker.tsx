import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, post, type Place, type ThingView } from "../lib/api.ts";
import { useAction } from "../lib/hooks.ts";
import { PlacePicker } from "../components/PlacePicker.tsx";

/** How many a thing stands for: its quantity, or 1 (D-036). */
export const quantity = (t: ThingView) =>
  typeof t.data.quantity === "number" && t.data.quantity >= 1 ? Math.floor(t.data.quantity) : 1;

/**
 * Move a thing: any place, a new one, "No fixed place" (D-026) or out of its place. With a
 * quantity, "how many" moves only some (a split, D-036); landing where the same stock already
 * is offers to put them together.
 */
export function MovePicker({ thing, onDone }: { thing: ThingView; onDone: () => void }) {
  const act = useAction();
  const have = quantity(thing);
  const [count, setCount] = useState(have);
  const n = Math.min(Math.max(1, Math.round(count) || 1), have);
  const { data: stock } = useQuery({
    queryKey: ["stock", thing.id],
    queryFn: () => get<{ family: ThingView[] }>(`/things/${thing.id}/stock`),
  });
  /** Picked a place where some of the same stock already is: ask first. */
  const [joining, setJoining] = useState<{ with: ThingView; place: Place | undefined } | null>(null);

  const some = n < have;
  const what = some ? `${n} of ${have}` : thing.name;

  function moveTo(to: string | null, place: Place | undefined, roams: boolean) {
    const there = to ? stock?.family.find((t) => t.parentId === to) : undefined;
    if (there) return setJoining({ with: there, place });
    onDone();
    const where = roams ? "no fixed place" : to ? (place?.name ?? "its new place") : null;
    if (some)
      void act(
        () => post(`/things/${thing.id}/split`, { count: n, to, ...(roams ? { roams: true } : {}) }),
        where ? `Moved ${what} to ${where}` : `Took ${what} out of its place`,
      );
    else
      void act(
        () => post(`/things/${thing.id}/move`, { to, ...(roams ? { roams: true } : {}) }),
        roams ? `${thing.name}: no fixed place` : where ? `Moved to ${where}` : "Taken out of its place",
      );
  }

  function join(into: ThingView) {
    onDone();
    void act(
      () => post(`/things/${into.id}/combine`, { from: [thing.id], ...(some ? { count: n } : {}) }),
      `Put together: ${into.name} ×${quantity(into) + n} in ${into.path.at(-1)?.name ?? "one place"}`,
    );
  }

  function keepApart(place: Place | undefined) {
    const to = joining!.with.parentId;
    setJoining(null);
    onDone();
    const where = place?.name ?? joining!.with.path.at(-1)?.name ?? "its new place";
    void act(
      () =>
        some ? post(`/things/${thing.id}/split`, { count: n, to }) : post(`/things/${thing.id}/move`, { to }),
      `Moved ${what} to ${where}`,
    );
  }

  if (joining) {
    const j = joining.with;
    return (
      <div className="stack" style={{ gap: 8 }}>
        <span>
          {quantity(j) > 1 ? `${j.name} ×${quantity(j)} are` : `${j.name} (${j.id}) is`} already in{" "}
          <b>{j.path.at(-1)?.name ?? "that place"}</b>.
        </span>
        <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn small" onClick={() => join(j)} autoFocus>
            Put together (×{quantity(j) + n})
          </button>
          <button type="button" className="btn small" onClick={() => keepApart(joining.place)}>
            Keep apart
          </button>
          <button type="button" className="btn ghost small" onClick={() => setJoining(null)}>
            Back
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      {have > 1 && (
        <label className="row small" style={{ gap: 8 }}>
          <span className="muted">How many</span>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={have}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            style={{ width: 80 }}
          />
          <span className="muted">of {have}</span>
          {some && <span className="muted">· the rest stay where they are</span>}
        </label>
      )}
      <PlacePicker
        label={`Move ${some ? `${n} ${thing.name}` : thing.name} to`}
        autoFocus
        allowRoam
        roams={thing.roams && !some}
        value={thing.parentId}
        onChange={(to, place, roams) => moveTo(to, place, roams ?? false)}
      />
    </div>
  );
}
