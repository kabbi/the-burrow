import type { Kind } from "./types.ts";

const common = [
  { key: "description", label: "Description", type: "text" },
  { key: "tags", label: "Tags", type: "tags" },
  { key: "quantity", label: "Quantity", type: "number" },
] as const;

/** Seed kinds. Users add more as data (kind.defined events), no code needed. */
export const builtinKinds: Kind[] = [
  { id: "thing", name: "Thing", isPlace: false, builtin: true, fields: [...common] },
  {
    id: "room",
    name: "Room",
    isPlace: true,
    builtin: true,
    fields: [{ key: "description", label: "Description", type: "text" }],
  },
  {
    id: "furniture",
    name: "Furniture",
    isPlace: true,
    builtin: true,
    fields: [
      ...common,
      { key: "maker", label: "Maker", type: "text" },
      { key: "model", label: "Model", type: "text" },
    ],
  },
  {
    id: "container",
    name: "Container",
    isPlace: true,
    builtin: true,
    fields: [...common, { key: "size", label: "Size", type: "text" }],
  },
  {
    id: "appliance",
    name: "Appliance",
    isPlace: false,
    builtin: true,
    fields: [
      ...common,
      { key: "maker", label: "Maker", type: "text", wanted: true },
      { key: "model", label: "Model", type: "text", wanted: true },
      { key: "serial", label: "Serial no.", type: "text", wanted: true },
      { key: "price", label: "Price", type: "money" },
      { key: "purchaseDate", label: "Bought on", type: "date" },
      { key: "url", label: "Product page", type: "url" },
    ],
  },
  {
    id: "electronics",
    name: "Electronics / PCB",
    isPlace: false,
    builtin: true,
    fields: [
      ...common,
      { key: "maker", label: "Maker", type: "text" },
      { key: "model", label: "Model", type: "text" },
      { key: "url", label: "Datasheet / page", type: "url" },
    ],
  },
  {
    id: "tool",
    name: "Tool",
    isPlace: false,
    builtin: true,
    fields: [
      ...common,
      { key: "maker", label: "Maker", type: "text" },
      { key: "model", label: "Model", type: "text" },
    ],
  },
];
