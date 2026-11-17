import type { BurrowEvent } from "./api.ts";
import { ROLE_LABEL } from "./roles.ts";

/** Names of the places a move went between, when the server knows them. */
export interface MoveNames {
  from?: string | null;
  to?: string | null;
}

/** One line for an event, in the household's words ("Moved to Hall", "Confirmed maker"). */
export function eventLabel(e: BurrowEvent, names: MoveNames = {}): string {
  const b = e.body;
  switch (b.type) {
    case "thing.created":
      return "Added";
    case "thing.changed":
      return `Changed ${b.changes.map((c) => c.field.replace(/^data\./, "")).join(", ")}`;
    case "thing.moved":
      if (b.to && b.to === b.from) return b.position ? `Spot: ${b.position}` : "Spot cleared";
      if (b.to)
        return `${names.to ? `Moved to ${names.to}` : "Moved"}${b.position ? ` · ${b.position}` : ""}`;
      return b.roams ? "No fixed place now" : "Taken out of its place";
    case "thing.status":
      return b.to === "missing" ? "Reported missing" : b.to === "ok" ? "Found" : "Marked not checked";
    case "thing.confirmed":
      return `${b.undo ? "Unconfirmed" : "Confirmed"} ${b.fields.join(", ")}`;
    case "thing.archived":
      return b.undo ? "Restored" : "Archived";
    case "ref.linked":
      return `Linked to ${b.service}`;
    case "edge.added":
      return b.edgeType === "tagged" ? "Tagged" : `Linked (${b.edgeType.replace(/_/g, " ")})`;
    case "edge.removed":
      return b.edgeType === "tagged" ? "Untagged" : `Unlinked (${b.edgeType.replace(/_/g, " ")})`;
    case "asset.added":
      return `Added ${ROLE_LABEL[b.asset.role].toLowerCase()}`;
    case "asset.changed":
      return b.to.thumb !== undefined && Object.keys(b.to).length === 1
        ? "New picture for a 3D model"
        : b.to.role
          ? `Picture is now: ${ROLE_LABEL[b.to.role].toLowerCase()}`
          : "Picture changed";
    case "asset.removed":
      return b.undo ? "Picture restored" : "Picture removed";
    case "asset.cover":
      return b.to ? "Cover changed" : "Cover automatic";
    default:
      return b.type.replace(".", " ");
  }
}
