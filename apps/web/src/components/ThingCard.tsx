import type { ThingView } from "../lib/api.ts";
import { ThingRow, ThingTile } from "../ui/thing.tsx";

export { PathView, StatusPill, Thumb, Where } from "../ui/thing.tsx";

/** One thing on its own: a tile in grids (`compact`), else a row in its own panel. */
export function ThingCard({ thing, compact }: { thing: ThingView; compact?: boolean }) {
  if (compact) return <ThingTile thing={thing} />;
  return (
    <div className="rows">
      <ThingRow thing={thing} />
    </div>
  );
}
