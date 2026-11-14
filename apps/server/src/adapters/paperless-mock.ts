import type {
  DocQuery,
  FilePatch,
  PaperlessApi,
  PlDoc,
  PlNamed,
  PlSuggestions,
  Taxonomy,
} from "./paperless.ts";

// An in-memory paperless with made-up documents, for UI work and tests.
// Enabled with PAPERLESS_MOCK=1. Nothing here is real data.

const tags: PlNamed[] = [
  { id: 1, name: "inbox", is_inbox_tag: true, color: "#c8441b" },
  { id: 2, name: "warranty", color: "#2f6f5e" },
  { id: 3, name: "receipt" },
  { id: 4, name: "manual" },
  { id: 5, name: "appliance" },
  { id: 6, name: "contract" },
  { id: 7, name: "vet" },
  { id: 8, name: "3d printing" },
];
const correspondents: PlNamed[] = [
  { id: 1, name: "Example Furniture Co." },
  { id: 2, name: "Example Telecom" },
  { id: 3, name: "Example Vet Clinic" },
  { id: 4, name: "Example Printer Maker" },
];
const documentTypes: PlNamed[] = [
  { id: 1, name: "Receipt" },
  { id: 2, name: "Contract" },
  { id: 3, name: "Manual" },
  { id: 4, name: "Medical record" },
  { id: 5, name: "Invoice" },
];

const doc = (id: number, title: string, added: string, extra: Partial<PlDoc> = {}): PlDoc => ({
  id,
  title,
  created: added.slice(0, 10),
  added,
  correspondent: null,
  document_type: null,
  storage_path: null,
  tags: [1],
  page_count: 1,
  archive_serial_number: null,
  original_file_name: `scan_${id}.pdf`,
  mime_type: "application/pdf",
  ...extra,
});

const suggestionsById: Record<number, PlSuggestions> = {
  101: { correspondents: [1], tags: [2, 3, 5], document_types: [1], storage_paths: [] },
  102: { correspondents: [2], tags: [6], document_types: [2], storage_paths: [] },
  103: { correspondents: [3], tags: [7], document_types: [4], storage_paths: [] },
  104: { correspondents: [4], tags: [2, 8], document_types: [5], storage_paths: [] },
  105: { correspondents: [], tags: [4], document_types: [3], storage_paths: [] },
};

export class PaperlessMock implements PaperlessApi {
  readonly mode = "mock" as const;
  private docs: PlDoc[] = [
    doc(101, "Dishwasher receipt", "2026-11-14T09:12:00Z"),
    doc(102, "Internet subscription contract", "2026-11-14T09:13:00Z", { page_count: 4 }),
    doc(103, "Dog vaccination record", "2026-11-14T09:15:00Z", { page_count: 2 }),
    doc(104, "3D printer invoice", "2026-11-13T18:40:00Z"),
    doc(105, "Scan 2026-11-12 0001", "2026-11-12T20:02:00Z"),
    doc(106, "Scan 2026-11-12 0002", "2026-11-12T20:03:00Z"),
    doc(201, "Washing machine manual", "2026-10-02T10:00:00Z", {
      tags: [4, 5],
      correspondent: null,
      document_type: 3,
      page_count: 48,
    }),
    doc(202, "Sofa receipt", "2026-09-20T10:00:00Z", { tags: [3], correspondent: 1, document_type: 1 }),
  ];

  async status() {
    return { ok: true, version: "mock", total: this.docs.length };
  }

  async taxonomy(): Promise<Taxonomy> {
    const count = (pick: (d: PlDoc) => number[]) => (t: PlNamed) => ({
      ...t,
      document_count: this.docs.filter((d) => pick(d).includes(t.id)).length,
    });
    return {
      tags: tags.map(count((d) => d.tags)),
      correspondents: correspondents.map(count((d) => (d.correspondent ? [d.correspondent] : []))),
      documentTypes: documentTypes.map(count((d) => (d.document_type ? [d.document_type] : []))),
      storagePaths: [],
    };
  }

  async documents(q: DocQuery) {
    let r = this.docs.toSorted((a, b) => b.added.localeCompare(a.added));
    if (q.tagsAny?.length) r = r.filter((d) => d.tags.some((t) => q.tagsAny!.includes(t)));
    if (q.tagsAll?.length) r = r.filter((d) => q.tagsAll!.every((t) => d.tags.includes(t)));
    if (q.correspondent) r = r.filter((d) => d.correspondent === q.correspondent);
    if (q.documentType) r = r.filter((d) => d.document_type === q.documentType);
    if (q.untriaged) r = r.filter((d) => !d.correspondent && !d.document_type);
    if (q.title) r = r.filter((d) => d.title.toLowerCase().includes(q.title!.toLowerCase()));
    const size = q.pageSize ?? 50;
    const page = q.page ?? 1;
    return { count: r.length, results: r.slice((page - 1) * size, page * size) };
  }

  async document(id: number) {
    const d = this.docs.find((x) => x.id === id);
    if (!d) throw new Error(`paperless: no document ${id}`);
    return { ...d };
  }

  async suggestions(id: number) {
    return suggestionsById[id] ?? { correspondents: [], tags: [], document_types: [], storage_paths: [] };
  }

  async update(id: number, patch: FilePatch) {
    const d = this.docs.find((x) => x.id === id);
    if (!d) throw new Error(`paperless: no document ${id}`);
    Object.assign(d, patch);
    return { ...d };
  }

  async thumbnail(id: number) {
    const d = await this.document(id);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420" viewBox="0 0 300 420">
      <rect width="300" height="420" fill="#fbfaf6"/>
      <rect x="24" y="28" width="150" height="16" rx="3" fill="#1c1b19"/>
      ${Array.from({ length: 14 }, (_, i) => `<rect x="24" y="${70 + i * 22}" width="${180 + ((i * 37) % 70)}" height="8" rx="3" fill="#ddd6c8"/>`).join("")}
      <text x="24" y="400" font-family="sans-serif" font-size="14" fill="#6b655a">mock #${d.id}</text></svg>`;
    return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
  }

  webUrl(id: number) {
    return `#mock-paperless-${id}`;
  }
}
