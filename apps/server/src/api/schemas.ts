import { z } from "zod";
import { ASSET_ROLES } from "@burrow/core";
import { component } from "./define.ts";

// The shapes the API answers with (they mirror @burrow/core/types). Objects are open:
// new properties may appear, so clients should ignore what they don't know.

const time = () => z.string().describe("ISO 8601 time");
const data = () => z.record(z.string(), z.unknown());

export const SOURCES = [
  "you",
  "ai",
  "page",
  "file",
  "homebox",
  "paperless",
  "import",
  "icons",
  "app",
] as const;
export const Source = component(
  "Source",
  z
    .enum(SOURCES)
    .describe(
      "Where a value came from: you (a person), ai (a guess, shown violet until confirmed), page (a shop page), file, import, app (an outside system; the event's actor says which)…",
    ),
);

export const FieldMeta = component(
  "FieldMeta",
  z.looseObject({ source: Source, confirmed: z.boolean().optional(), at: time() }),
);

export const PathSegment = component(
  "PathSegment",
  z.looseObject({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    position: z.string().nullable().optional().describe("Spot inside the previous segment"),
  }),
);

export const TagRef = component(
  "TagRef",
  z.looseObject({
    id: z.string(),
    name: z.string(),
    path: z.array(z.string()).describe("Ancestor tag names, outermost first"),
    source: Source.optional(),
  }),
);

export const Ref = component(
  "Ref",
  z.looseObject({
    thingId: z.string(),
    service: z.string(),
    remoteId: z.string(),
    data: data(),
    syncedAt: time(),
  }),
);

export const AssetRef = component(
  "AssetRef",
  z.looseObject({
    id: z.string(),
    role: z.enum(ASSET_ROLES),
    mime: z.string(),
    fileUrl: z.string().describe("/media/<file>"),
    imageUrl: z.string().nullable().describe("A picture to show at full size (a model's poster for 3D)"),
    thumbUrl: z.string().nullable(),
    originalUrl: z.string().nullable().describe("The untouched camera original, if kept"),
  }),
);

export const Thing = component(
  "Thing",
  z.looseObject({
    id: z.string().describe('"B-0042"'),
    seq: z.number().int(),
    kind: z.string().describe("Kind id, see /schema"),
    name: z.string(),
    data: data().describe("Field values by key (the kind's declared fields and any extra ones)"),
    meta: z
      .record(z.string(), FieldMeta)
      .describe('Provenance per field: "name", "kind", "parent" or a data key'),
    parentId: z.string().nullable().describe("The place it is inside"),
    position: z.string().nullable().describe('Spot inside the parent ("shelf 3")'),
    roams: z.boolean().describe("No fixed place: it travels (laptop, phone). Not a gap, unlike no parent."),
    status: z.enum(["ok", "unverified", "missing"]),
    createdAt: time(),
    updatedAt: time(),
    archivedAt: time().nullable(),
    path: z.array(PathSegment).describe("Places from the outermost down to the parent"),
    refs: z.array(Ref),
    gaps: z.array(z.string()).describe('What is missing: "place" or wanted field keys'),
    childCount: z.number().int(),
    tags: z.array(TagRef),
    cover: AssetRef.nullable(),
  }),
);

export const Asset = component(
  "Asset",
  z.looseObject({
    id: z.string().describe('"A-0001"'),
    thingId: z.string(),
    role: z.enum(ASSET_ROLES),
    file: z.string().describe("Content-addressed file name, served at /media/<file>"),
    mime: z.string(),
    bytes: z.number().int(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    thumb: z.string().optional(),
    original: z.string().optional(),
    key: z.string().optional().describe("The caller's own stable id, unique per thing"),
    label: z.string().optional(),
    source: Source,
    data: data(),
    addedAt: time(),
    removedAt: time().nullable(),
    fileUrl: z.string(),
    imageUrl: z.string().nullable(),
    thumbUrl: z.string().nullable(),
    originalUrl: z.string().nullable(),
  }),
);

export const Event = component(
  "Event",
  z.looseObject({
    seq: z.number().int().describe("Position in the log; use as a cursor"),
    at: time(),
    actor: z.string().describe('Who did it: "you", "ai", or an app\'s actor name'),
    body: z
      .looseObject({ type: z.string() })
      .describe(
        "thing.created, thing.changed, thing.moved, edge.added, asset.added, … (see the event types)",
      ),
    undoOf: z.number().int().nullable().describe("The event this one reverses"),
    undone: z.boolean().optional().describe("A later event reversed this one"),
  }),
);

export const KindField = component(
  "KindField",
  z.looseObject({
    key: z.string(),
    label: z.string(),
    type: z.enum(["text", "longtext", "number", "money", "date", "boolean", "url", "select", "list", "ref"]),
    options: z.array(z.string()).optional().describe("Choices for select"),
    refKind: z.string().optional().describe("For ref: only things of this kind"),
    unit: z.string().optional(),
    wanted: z.boolean().optional().describe("Missing values show up as gaps"),
  }),
);

export const Kind = component(
  "Kind",
  z.looseObject({
    id: z.string(),
    name: z.string(),
    parent: z.string().nullable().describe("Inherits fields and traits from this kind"),
    isPlace: z.boolean(),
    physical: z.boolean(),
    fields: z.array(KindField).describe("Own fields"),
    builtin: z.boolean(),
    effectiveFields: z.array(KindField).describe("Own and inherited fields"),
  }),
);

export const RelationType = component(
  "RelationType",
  z.looseObject({
    id: z.string(),
    name: z.string().describe('Read from → to: "accessory of"'),
    inverse: z.string().describe('Read to → from: "accessories"'),
    fromKinds: z.array(z.string()),
    toKinds: z.array(z.string()),
    cardinality: z.enum(["one", "many"]),
    symmetric: z.boolean(),
    builtin: z.boolean(),
  }),
);

export const Relation = component(
  "Relation",
  z.looseObject({
    edgeId: z.number().int(),
    type: z.string(),
    direction: z.enum(["out", "in"]).describe("out: this thing is `from`"),
    label: z.string(),
    other: z.looseObject({ id: z.string(), name: z.string(), kind: z.string() }),
    data: data(),
  }),
);

export const Place = component(
  "Place",
  z.looseObject({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    path: z.string().describe('"Garage / Shelf"'),
    depth: z.number().int(),
  }),
);

export const PlaceNode = component(
  "PlaceNode",
  z.looseObject({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    parentId: z.string().nullable(),
    position: z.string().nullable(),
    cover: AssetRef.nullable(),
    items: z.number().int().describe("Things directly inside"),
    total: z.number().int().describe("Things inside at any depth"),
    status: z.enum(["ok", "unverified", "missing"]),
  }),
);

export const Tag = component(
  "Tag",
  z.looseObject({
    id: z.string(),
    name: z.string(),
    parentId: z.string().nullable(),
    path: z.array(z.string()),
    aliases: z.array(z.string()),
    uses: z.number().int(),
  }),
);

export const TokenInfo = component(
  "TokenInfo",
  z.looseObject({
    id: z.string(),
    name: z.string(),
    actor: z.string(),
    scopes: z.array(z.enum(["read", "write", "schema"])),
    hint: z.string(),
    createdAt: time(),
    lastUsedAt: time().nullable(),
    revokedAt: time().nullable(),
  }),
);
