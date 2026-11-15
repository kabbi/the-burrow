import type {
  PlaceNode,
  Asset,
  AssetRef,
  AssetRole,
  BurrowEvent,
  Kind,
  KindField,
  RelationType,
  RelationView,
  SearchHit,
  ThingView,
} from "@burrow/core/types";

export type { PlaceNode, AssetRole, BurrowEvent, Kind, KindField, RelationType, RelationView, ThingView };

/** An asset plus the URLs to draw it. */
export type AssetView = Asset & AssetRef;

/** Asset writes answer with the thing's assets, its cover and the event (for Undo). */
export interface AssetsReply {
  assets: AssetView[];
  cover: AssetRef | null;
  asset?: AssetView;
  event?: BurrowEvent;
}

/** Send a file as the raw request body (no multipart). */
export async function upload<T = AssetsReply>(path: string, file: Blob, query: Record<string, string> = {}) {
  const res = await fetch(`/api${path}?${new URLSearchParams(query)}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`);
  return json;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`);
  return json;
}

/** Writes return the event they appended (for Undo) unless told otherwise. */
type Written = { event?: BurrowEvent };
export const get = <T>(p: string) => req<T>("GET", p);
export const post = <T = Written>(p: string, b: unknown = {}) => req<T>("POST", p, b);
export const patch = <T = Written>(p: string, b: unknown) => req<T>("PATCH", p, b);
export const put = <T = Written>(p: string, b: unknown) => req<T>("PUT", p, b);
export const del = <T = Written>(p: string, b?: unknown) => req<T>("DELETE", p, b);

export interface EventRow extends BurrowEvent {
  undoable: boolean;
  thing: { id: string; name: string; from: string | null; to: string | null } | null;
}

export interface Place {
  id: string;
  name: string;
  kind: string;
  path: string;
  depth: number;
}

export interface Overview {
  stats: { things: number; places: number; missing: number; events: number; tags: number; documents: number };
  needsDetails: number;
  aiChecks: { things: number; fields: number; names: string[] };
  places: { unplaced: number; roaming: number };
  missing: ThingView[];
  recentlyAdded: ThingView[];
  moves: BurrowEvent[];
  papers: { mode: "live" | "mock" | "off"; inbox: number | null };
  ai: { totalUsd: number; monthUsd: number; runs: number };
}

export interface ThingDetail {
  thing: ThingView;
  fields: KindField[];
  children: ThingView[];
  relations: (RelationView & { paperlessId: string | null })[];
  tagged: ThingView[];
  assets: AssetView[];
  /** The cover someone chose (null: automatic). */
  coverId: string | null;
  /** Spots already used in this thing's place ("shelf 1"…), for suggestions. */
  spots: string[];
  paperlessId: string | null;
  events: (BurrowEvent & { undoable: boolean })[];
}

export interface SchemaKind extends Kind {
  effectiveFields: KindField[];
  things: number;
  isTag: boolean;
  isDocument: boolean;
}

export interface Schema {
  kinds: SchemaKind[];
  relations: (RelationType & { links: number })[];
}

export interface TagInfo {
  id: string;
  name: string;
  parentId: string | null;
  path: string[];
  aliases: string[];
  uses: number;
}

export interface Preview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  price?: string;
  brand?: string;
}

export interface Quote {
  id: string;
  task: string;
  provider: "anthropic" | "ollama" | "lmstudio";
  model: string;
  estInputTokens: number;
  estOutputTokens: number;
  tokensExact: boolean;
  estCostUsd: number | null;
  maxCostUsd: number | null;
  autoApprove: boolean;
  expiresAt: string;
}

export interface AiRecord extends Quote {
  status: "quoted" | "running" | "done" | "failed" | "expired";
  createdAt: string;
  actualModel: string | null;
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  actualCostUsd: number | null;
  error: string | null;
  result: unknown;
}

export interface Providers {
  anthropic: {
    configured: boolean;
    defaultModel: string;
    models: { id: string; input: number; output: number }[];
  };
  ollama: {
    configured: boolean;
    defaultModel: string;
    models: { name: string; sizeGb: number; params: string }[];
  };
  lmstudio: {
    configured: boolean;
    defaultModel: string;
    models: { name: string; type: string; context: number }[];
  };
  spend: { totalUsd: number; monthUsd: number; runs: number };
  autoApproveUsd: number;
}

export interface PaperDoc {
  id: number;
  title: string;
  created: string;
  added: string;
  correspondent: number | null;
  document_type: number | null;
  tags: number[];
  page_count: number | null;
  original_file_name: string | null;
  correspondentName: string | null;
  documentTypeName: string | null;
  tagNames: string[];
  things: { id: string; name: string }[];
  why?: string;
}

export interface Named {
  id: number;
  name: string;
  document_count?: number;
  is_inbox_tag?: boolean;
}

export interface Taxonomy {
  tags: Named[];
  correspondents: Named[];
  documentTypes: Named[];
  storagePaths: Named[];
  inboxTagIds: number[];
}

export interface DocDetail {
  doc: PaperDoc;
  entity: ThingView | null;
  suggestions: { correspondents: number[]; tags: number[]; document_types: number[] } | null;
  guesses: { id: string; name: string; path: string[] }[];
  inboxTagIds: number[];
  webUrl: string;
}

export type Hits = { hits: SearchHit[] };

export interface TidyData {
  gaps: ThingView[];
  aiChecks: { thing: ThingView; fields: string[] }[];
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "free (local)";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}
