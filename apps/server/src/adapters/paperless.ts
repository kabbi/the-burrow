import { getJson, UpstreamError } from "./http.ts";

// paperless-ngx REST API (tested against 3.1 / API v10).
//
// PRIVACY RULE: Burrow never asks paperless for document *content* (OCR text,
// files, notes). Document lists always pass an explicit `fields=` allowlist so
// the `content` field is never returned. Thumbnails are only proxied straight
// to the user's browser. See docs/decisions.md (D-006).

export const DOC_FIELDS = [
  "id",
  "title",
  "created",
  "added",
  "correspondent",
  "document_type",
  "storage_path",
  "tags",
  "page_count",
  "archive_serial_number",
  "original_file_name",
  "mime_type",
] as const;

export interface PlDoc {
  id: number;
  title: string;
  created: string;
  added: string;
  correspondent: number | null;
  document_type: number | null;
  storage_path: number | null;
  tags: number[];
  page_count: number | null;
  archive_serial_number: number | null;
  original_file_name: string | null;
  mime_type: string | null;
}

export interface PlNamed {
  id: number;
  name: string;
  document_count?: number;
  is_inbox_tag?: boolean;
  color?: string;
}

export interface Taxonomy {
  tags: PlNamed[];
  correspondents: PlNamed[];
  documentTypes: PlNamed[];
  storagePaths: PlNamed[];
}

/** Paperless' own classifier output (ids only; `dates` is dropped — it is read from content). */
export interface PlSuggestions {
  correspondents: number[];
  tags: number[];
  document_types: number[];
  storage_paths: number[];
}

export interface FilePatch {
  title?: string;
  correspondent?: number | null;
  document_type?: number | null;
  storage_path?: number | null;
  tags?: number[];
}

export interface DocQuery {
  tagsAny?: number[];
  tagsAll?: number[];
  correspondent?: number;
  documentType?: number;
  /** Only documents without a correspondent AND without a type. */
  untriaged?: boolean;
  /** Title-only search (`title__icontains`), never full-text. */
  title?: string;
  page?: number;
  pageSize?: number;
}

export interface PaperlessApi {
  readonly mode: "live" | "mock" | "off";
  status(): Promise<{ ok: boolean; version?: string; total?: number }>;
  taxonomy(): Promise<Taxonomy>;
  documents(q: DocQuery): Promise<{ count: number; results: PlDoc[] }>;
  document(id: number): Promise<PlDoc>;
  suggestions(id: number): Promise<PlSuggestions>;
  update(id: number, patch: FilePatch): Promise<PlDoc>;
  thumbnail(id: number): Promise<Response>;
  webUrl(id: number): string;
}

export class Paperless implements PaperlessApi {
  readonly mode = "live" as const;
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private req<T>(path: string, init: RequestInit = {}) {
    return getJson<T>("paperless", `${this.url}/api${path}`, {
      ...init,
      headers: {
        Authorization: `Token ${this.token}`,
        Accept: "application/json; version=9",
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  }

  async status() {
    const s = await this.req<{ documents_total: number }>("/statistics/");
    return { ok: true, total: s.documents_total };
  }

  async taxonomy(): Promise<Taxonomy> {
    const all = async (p: string) =>
      (
        await this.req<{ results: PlNamed[] }>(
          `/${p}/?page_size=1000&fields=id,name,document_count,is_inbox_tag,color`,
        )
      ).results;
    const [tags, correspondents, documentTypes, storagePaths] = await Promise.all([
      all("tags"),
      all("correspondents"),
      all("document_types"),
      all("storage_paths"),
    ]);
    return { tags, correspondents, documentTypes, storagePaths };
  }

  documents(q: DocQuery) {
    const p = new URLSearchParams({
      fields: DOC_FIELDS.join(","),
      ordering: "-added",
      page: String(q.page ?? 1),
      page_size: String(q.pageSize ?? 50),
    });
    if (q.tagsAny?.length) p.set("tags__id__in", q.tagsAny.join(","));
    if (q.tagsAll?.length) p.set("tags__id__all", q.tagsAll.join(","));
    if (q.correspondent) p.set("correspondent__id", String(q.correspondent));
    if (q.documentType) p.set("document_type__id", String(q.documentType));
    if (q.untriaged) {
      p.set("correspondent__isnull", "true");
      p.set("document_type__isnull", "true");
    }
    if (q.title) p.set("title__icontains", q.title);
    return this.req<{ count: number; results: PlDoc[] }>(`/documents/?${p}`);
  }

  document(id: number) {
    return this.req<PlDoc>(`/documents/${id}/?fields=${DOC_FIELDS.join(",")}`);
  }

  async suggestions(id: number): Promise<PlSuggestions> {
    const s = await this.req<PlSuggestions & { dates?: unknown }>(`/documents/${id}/suggestions/`);
    return {
      correspondents: s.correspondents ?? [],
      tags: s.tags ?? [],
      document_types: s.document_types ?? [],
      storage_paths: s.storage_paths ?? [],
    };
  }

  async update(id: number, patch: FilePatch) {
    await this.req(`/documents/${id}/`, { method: "PATCH", body: JSON.stringify(patch) });
    return this.document(id);
  }

  async thumbnail(id: number) {
    const res = await fetch(`${this.url}/api/documents/${id}/thumb/`, {
      headers: { Authorization: `Token ${this.token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new UpstreamError("paperless", res.status, `thumb HTTP ${res.status}`);
    return res;
  }

  webUrl(id: number) {
    return `${this.url}/documents/${id}/details`;
  }
}

export class PaperlessOff implements PaperlessApi {
  readonly mode = "off" as const;
  private fail(): never {
    throw new UpstreamError("paperless", 503, "not configured");
  }
  async status() {
    return { ok: false };
  }
  taxonomy = async () => this.fail();
  documents = async () => this.fail();
  document = async () => this.fail();
  suggestions = async () => this.fail();
  update = async () => this.fail();
  thumbnail = async () => this.fail();
  webUrl = () => "";
}
