import { post, type ThingView } from "../lib/api.ts";
import { useAction } from "../lib/hooks.ts";
import { PlacePicker } from "../components/PlacePicker.tsx";

/** Move a thing: any place, a new one, "No fixed place" (D-026) or out of its place. */
export function MovePicker({ thing, onDone }: { thing: ThingView; onDone: () => void }) {
  const act = useAction();
  return (
    <PlacePicker
      label={`Move ${thing.name} to`}
      autoFocus
      allowRoam
      roams={thing.roams}
      value={thing.parentId}
      onChange={(to, place, roams) => {
        onDone();
        void act(
          () => post(`/things/${thing.id}/move`, { to, ...(roams ? { roams: true } : {}) }),
          roams
            ? `${thing.name}: no fixed place`
            : to
              ? `Moved to ${place?.name ?? "its new place"}`
              : "Taken out of its place",
        );
      }}
    />
  );
}
