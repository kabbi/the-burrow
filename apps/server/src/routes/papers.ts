import { Router } from "express";
import { z } from "zod";
import type { Store } from "@burrow/core";
import type { Deps } from "../app.ts";
import type { PaperlessApi, PlDoc, Taxonomy } from "../adapters/paperless.ts";

// Papers = paperless-ngx seen through Burrow. Only metadata is read (D-006).

/**
 * The Burrow side of a paperless document (D-011): a `document` thing linked by
 * ref, holding only the cached title plus our own fields (physical copy place…).
 * Created on first link/enrich, never for every document up front.
 */
export function ensureDocument(store: Store, doc: Pick<PlDoc, "id" | "title">): string {
  const existing = store.findRef("paperless", String(doc.id));
  if (existing) {
    const t = store.getRaw(existing.thingId);
    if (t && t.name !== doc.title && t.meta.name?.source === "paperless")
      store.change(t.id, { name: doc.title }, "paperless", "paperless");
    return existing.thingId;
  }
  const t = store.createThing({ name: doc.title, kind: "document", source: "paperless" }, "paperless");
  store.link(t.id, "paperless", String(doc.id), {}, "paperless");
  return t.id;
}

function docEntity(store: Store, docId: number) {
  const ref = store.findRef("paperless", String(docId));
  return ref ? store.get(ref.thingId) : null;
}

export function paperRoutes({ store, paperless, inboxTagNames }: Deps): Router {
  const r = Router();
  let taxCache: { at: number; tax: Taxonomy } | null = null;
  const taxonomy = async (fresh = false) => {
    if (!fresh && taxCache && Date.now() - taxCache.at < 60_000) return taxCache.tax;
    taxCache = { at: Date.now(), tax: await paperless.taxonomy() };
    return taxCache.tax;
  };
  const inboxTagIds = (tax: Taxonomy) =>
    tax.tags.filter((t) => t.is_inbox_tag || inboxTagNames.includes(t.name.toLowerCase())).map((t) => t.id);

  r.get("/papers/status", async (_req, res) => {
    try {
      res.json({ mode: paperless.mode, ...(await paperless.status()) });
    } catch (e) {
      res.json({ mode: paperless.mode, ok: false, error: (e as Error).message });
    }
  });

  r.get("/papers/taxonomy", async (_req, res) => {
    const tax = await taxonomy(true);
    res.json({ ...tax, inboxTagIds: inboxTagIds(tax) });
  });

  /** Inbox = docs with an inbox tag, plus docs nobody triaged (no correspondent, no type). */
  r.get("/papers/inbox", async (_req, res) => {
    const tax = await taxonomy();
    res.json(await inbox(paperless, tax, inboxTagIds(tax), store));
  });

  r.get("/papers/docs", async (req, res) => {
    const q = req.query;
    const tax = await taxonomy();
    const out = await paperless.documents({
      ...(q.tag ? { tagsAll: [Number(q.tag)] } : {}),
      ...(q.type ? { documentType: Number(q.type) } : {}),
      ...(q.correspondent ? { correspondent: Number(q.correspondent) } : {}),
      ...(q.title ? { title: String(q.title) } : {}),
      page: Number(q.page ?? 1),
      pageSize: 50,
    });
    res.json({ count: out.count, docs: out.results.map((d) => decorate(d, tax, store)) });
  });

  r.get("/papers/docs/:id", async (req, res) => {
    const id = Number(req.params.id);
    const tax = await taxonomy();
    const [doc, sugg] = await Promise.all([
      paperless.document(id),
      paperless.suggestions(id).catch(() => null),
    ]);
    const linked = linkedThings(store, id);
    const entity = docEntity(store, id);
    // Burrow's own guess: things whose names share words with the title.
    const guesses = store
      .search(doc.title, 5, { any: true })
      .filter((h) => !linked.some((l) => l.id === h.thing.id))
      .slice(0, 3)
      .map((h) => ({ id: h.thing.id, name: h.thing.name, path: h.thing.path.map((p) => p.name) }));
    res.json({
      doc: decorate(doc, tax, store),
      entity,
      suggestions: sugg,
      guesses,
      inboxTagIds: inboxTagIds(tax),
      webUrl: paperless.webUrl(id),
    });
  });

  const FileBody = z.object({
    title: z.string().min(1).optional(),
    correspondent: z.number().nullable().optional(),
    document_type: z.number().nullable().optional(),
    tags: z.array(z.number()).optional(),
    /** Burrow things this paper belongs to (receipt of, manual of, …). */
    thingIds: z.array(z.string()).default([]),
    /** Remove inbox tags when filing. */
    done: z.boolean().default(true),
  });

  r.post("/papers/docs/:id/file", async (req, res) => {
    const id = Number(req.params.id);
    const b = FileBody.parse(req.body);
    const tax = await taxonomy();
    const current = await paperless.document(id);
    const inboxIds = inboxTagIds(tax);
    let tags = b.tags ?? current.tags;
    if (b.done) tags = tags.filter((t) => !inboxIds.includes(t));
    const updated = await paperless.update(id, {
      ...(b.title !== undefined ? { title: b.title } : {}),
      ...(b.correspondent !== undefined ? { correspondent: b.correspondent } : {}),
      ...(b.document_type !== undefined ? { document_type: b.document_type } : {}),
      tags,
    });
    if (b.thingIds.length) {
      const docThing = ensureDocument(store, updated);
      for (const thingId of b.thingIds) store.relate("has_document", store.mustGet(thingId).id, docThing);
    }
    res.json({ doc: decorate(updated, tax, store) });
  });

  r.post("/papers/docs/:id/link", async (req, res) => {
    const id = Number(req.params.id);
    const b = z.object({ thingId: z.string() }).parse(req.body);
    const docThing = ensureDocument(store, await paperless.document(id));
    store.relate("has_document", store.mustGet(b.thingId).id, docThing);
    res.json({ things: linkedThings(store, id) });
  });

  r.delete("/papers/docs/:id/link/:thingId", (req, res) => {
    const id = Number(req.params.id);
    const doc = docEntity(store, id);
    if (doc) store.unrelate("has_document", store.mustGet(req.params.thingId).id, doc.id);
    res.json({ things: linkedThings(store, id) });
  });

  /** Where the physical copy lives (a binder, a drawer…), or null for "no paper copy". */
  r.post("/papers/docs/:id/place", async (req, res) => {
    const id = Number(req.params.id);
    const b = z.object({ placeId: z.string().nullable() }).parse(req.body);
    const docThing = ensureDocument(store, await paperless.document(id));
    store.move(docThing, b.placeId);
    store.change(docThing, { data: { physicalCopy: b.placeId !== null } });
    res.json({
      entity: store.get(docThing),
      event: store.events({ thingId: docThing, types: ["thing.moved"], limit: 1 })[0],
    });
  });

  r.get("/papers/docs/:id/thumb", async (req, res) => {
    const up = await paperless.thumbnail(Number(req.params.id));
    res.setHeader("content-type", up.headers.get("content-type") ?? "image/webp");
    res.setHeader("cache-control", "private, max-age=3600");
    res.send(Buffer.from(await up.arrayBuffer()));
  });

  return r;
}

async function inbox(p: PaperlessApi, tax: Taxonomy, inboxIds: number[], store: Store) {
  const [tagged, untriaged] = await Promise.all([
    inboxIds.length ? p.documents({ tagsAny: inboxIds, pageSize: 100 }) : { count: 0, results: [] },
    p.documents({ untriaged: true, pageSize: 100 }),
  ]);
  const seen = new Set<number>();
  const docs = [...tagged.results, ...untriaged.results]
    .filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
    .toSorted((a, b) => b.added.localeCompare(a.added))
    .map((d) => ({
      ...decorate(d, tax, store),
      why: d.tags.some((t) => inboxIds.includes(t)) ? "inbox tag" : "not sorted yet",
    }));
  return { count: docs.length, docs, inboxTagIds: inboxIds };
}

function decorate(d: PlDoc, tax: Taxonomy, store: Store) {
  const name = (list: { id: number; name: string }[], id: number | null) =>
    id === null ? null : (list.find((x) => x.id === id)?.name ?? `#${id}`);
  return {
    ...d,
    correspondentName: name(tax.correspondents, d.correspondent),
    documentTypeName: name(tax.documentTypes, d.document_type),
    tagNames: d.tags.map((t) => name(tax.tags, t)!),
    things: linkedThings(store, d.id),
  };
}

function linkedThings(store: Store, docId: number) {
  const doc = docEntity(store, docId);
  if (!doc) return [];
  return store
    .relations(doc.id)
    .filter((r) => r.type === "has_document" && r.direction === "in")
    .map((r) => ({ id: r.other.id, name: r.other.name }));
}
