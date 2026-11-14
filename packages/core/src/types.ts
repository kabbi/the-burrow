// Shared DTOs. Imported by the server and (type-only) by the web app,
// so keep this file free of runtime dependencies on node: modules.

/** Burrow's own human-facing id, e.g. "B-0042". See docs/decisions.md (D-003). */
export type ThingId = string;

/** Where a field value came from. Drives the colour code in the UI (AI = violet). */
export type FieldSource =
  | "you" // typed or confirmed by a person
  | "ai" // a model guessed it; shown violet until confirmed
  | "page" // scraped from a product page
  | "file" // read from a file (3D model, photo EXIF, ...)
  | "homebox"
  | "paperless"
  | "import";

export interface FieldMeta {
  source: FieldSource;
  /** A person looked at an AI/page value and said "yes, right". */
  confirmed?: boolean;
  at: string;
}

/** ok = location trusted; unverified = nobody checked lately; missing = "it's not here". */
export type ThingStatus = "ok" | "unverified" | "missing";

export interface Thing {
  id: ThingId;
  seq: number;
  kind: string;
  name: string;
  /** Free-form own fields; well-known keys are listed in KnownFields. */
  data: Record<string, unknown>;
  /** Per-field provenance. Keys: "name", "kind", "parent", or a data key. */
  meta: Record<string, FieldMeta>;
  parentId: ThingId | null;
  status: ThingStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** Common optional data keys. Not enforced; kinds can add their own. */
export interface KnownFields {
  description?: string;
  quantity?: number;
  tags?: string[];
  maker?: string;
  model?: string;
  serial?: string;
  price?: number;
  currency?: string;
  url?: string;
  imageUrl?: string;
  notes?: string;
  /** 0 common … 4 legendary. See docs/ideas.md (rarity tiers). */
  tier?: number;
}

export interface KindField {
  key: string;
  label: string;
  type: "text" | "number" | "tags" | "url" | "date" | "money";
  /** Missing wanted fields show up in "Needs details". */
  wanted?: boolean;
}

export interface Kind {
  id: string;
  name: string;
  /** Rooms, furniture, boxes: things other things can be inside. */
  isPlace: boolean;
  fields: KindField[];
  builtin: boolean;
}

export interface PathSegment {
  id: ThingId;
  name: string;
  kind: string;
}

export interface ThingView extends Thing {
  /** Ancestors from the outermost place down to the direct parent. */
  path: PathSegment[];
  refs: ExternalRef[];
  gaps: string[];
  childCount: number;
}

export interface ExternalRef {
  thingId: ThingId;
  service: string;
  remoteId: string;
  data: Record<string, unknown>;
  syncedAt: string;
}

export interface Edge {
  id: number;
  type: string;
  fromId: string;
  toId: string;
  data: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------- events

export interface FieldChange {
  /** "name" | "kind" | "data.<key>" */
  field: string;
  from: unknown;
  to: unknown;
  source?: FieldSource;
  /** Provenance before the change, so undo can restore it. */
  fromMeta?: FieldMeta | null;
  /** Exact provenance to set (used by undo); otherwise derived from `source`. */
  toMeta?: FieldMeta | null;
}

export type EventBody =
  | {
      type: "thing.created";
      id: ThingId;
      seq: number;
      kind: string;
      name: string;
      data: Record<string, unknown>;
      meta: Record<string, FieldMeta>;
      parentId: ThingId | null;
    }
  | { type: "thing.changed"; id: ThingId; changes: FieldChange[] }
  | { type: "thing.moved"; id: ThingId; from: ThingId | null; to: ThingId | null; source?: FieldSource }
  | { type: "thing.status"; id: ThingId; from: ThingStatus; to: ThingStatus; note?: string }
  | { type: "thing.confirmed"; id: ThingId; fields: string[]; undo?: boolean }
  | { type: "thing.archived"; id: ThingId; undo?: boolean }
  | {
      type: "ref.linked";
      thingId: ThingId;
      service: string;
      remoteId: string;
      data: Record<string, unknown>;
    }
  | { type: "ref.unlinked"; thingId: ThingId; service: string; remoteId: string }
  | {
      type: "edge.added";
      edgeType: string;
      fromId: string;
      toId: string;
      data: Record<string, unknown>;
    }
  | { type: "edge.removed"; edgeType: string; fromId: string; toId: string }
  | { type: "kind.defined"; kind: Omit<Kind, "builtin"> };

export type EventType = EventBody["type"];

export interface BurrowEvent {
  seq: number;
  at: string;
  actor: string;
  body: EventBody;
  /** seq of the event this one reverses, if it is an undo. */
  undoOf: number | null;
  /** true when a later event undid this one (derived). */
  undone?: boolean;
}

export interface SearchHit {
  thing: ThingView;
  score: number;
}
