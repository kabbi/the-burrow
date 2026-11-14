import type { Kind, KindField, RelationType } from "./types.ts";

const f = (
  key: string,
  label: string,
  type: KindField["type"],
  extra: Partial<KindField> = {},
): KindField => ({
  key,
  label,
  type,
  ...extra,
});

/**
 * Seed kinds. Users add or change kinds as data (kind.defined events); a
 * user definition with the same id overrides a seed. Fields are inherited
 * through `parent`.
 */
export const builtinKinds: Kind[] = [
  {
    id: "thing",
    name: "Thing",
    parent: null,
    isPlace: false,
    physical: true,
    builtin: true,
    fields: [
      f("description", "Description", "longtext"),
      f("quantity", "Quantity", "number"),
      f("maker", "Maker", "text"),
      f("model", "Model", "text"),
      f("url", "Link", "url"),
      f("price", "Price", "money"),
      f("purchaseDate", "Bought on", "date"),
      f("notes", "Notes", "longtext"),
    ],
  },
  {
    id: "electronics",
    name: "Electronics / PCB",
    parent: "thing",
    isPlace: false,
    physical: true,
    builtin: true,
    fields: [],
  },
  { id: "tool", name: "Tool", parent: "thing", isPlace: false, physical: true, builtin: true, fields: [] },
  {
    id: "appliance",
    name: "Appliance",
    parent: "thing",
    isPlace: false,
    physical: true,
    builtin: true,
    fields: [
      f("maker", "Maker", "text", { wanted: true }),
      f("model", "Model", "text", { wanted: true }),
      f("serial", "Serial no.", "text", { wanted: true }),
      f("warrantyUntil", "Warranty until", "date"),
    ],
  },
  {
    id: "room",
    name: "Room",
    parent: null,
    isPlace: true,
    physical: true,
    builtin: true,
    fields: [f("description", "Description", "longtext"), f("floor", "Floor", "text")],
  },
  {
    id: "furniture",
    name: "Furniture",
    parent: "thing",
    isPlace: true,
    physical: true,
    builtin: true,
    fields: [],
  },
  {
    id: "container",
    name: "Container",
    parent: "thing",
    isPlace: true,
    physical: true,
    builtin: true,
    fields: [f("size", "Size", "text")],
  },
  {
    id: "tag",
    name: "Tag",
    parent: null,
    isPlace: false,
    physical: false,
    builtin: true,
    fields: [
      f("description", "Description", "longtext"),
      f("aliases", "Also called", "list"),
      f("color", "Colour", "text"),
    ],
  },
  {
    // Paperless owns the document itself (D-011); this is the link plus our own extras.
    // A physical copy's location is simply its place (e.g. inside a binder).
    id: "document",
    name: "Document",
    parent: null,
    isPlace: false,
    physical: false,
    builtin: true,
    fields: [
      f("physicalCopy", "Physical copy kept", "boolean"),
      f("keepUntil", "Keep until", "date"),
      f("notes", "Notes", "longtext"),
    ],
  },
];

export const builtinRelations: RelationType[] = [
  {
    id: "tagged",
    name: "tagged",
    inverse: "tag of",
    fromKinds: [],
    toKinds: ["tag"],
    cardinality: "many",
    symmetric: false,
    builtin: true,
  },
  {
    id: "has_document",
    name: "papers",
    inverse: "paper for",
    fromKinds: [],
    toKinds: ["document"],
    cardinality: "many",
    symmetric: false,
    builtin: true,
  },
  {
    id: "accessory_of",
    name: "accessory of",
    inverse: "accessories",
    fromKinds: [],
    toKinds: [],
    cardinality: "many",
    symmetric: false,
    builtin: true,
  },
  {
    id: "part_of",
    name: "part of",
    inverse: "parts",
    fromKinds: [],
    toKinds: [],
    cardinality: "many",
    symmetric: false,
    builtin: true,
  },
  {
    id: "replaces",
    name: "replaces",
    inverse: "replaced by",
    fromKinds: [],
    toKinds: [],
    cardinality: "one",
    symmetric: false,
    builtin: true,
  },
  {
    id: "related",
    name: "related to",
    inverse: "related to",
    fromKinds: [],
    toKinds: [],
    cardinality: "many",
    symmetric: true,
    builtin: true,
  },
];
