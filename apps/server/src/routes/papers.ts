import { Router } from "express";
import { z } from "zod";
import type { Store } from "@burrow/core";
import type { Deps } from "../app.ts";
import type { PaperlessApi, PlDoc, Taxonomy } from "../adapters/paperless.ts";

// Papers = paperless-ngx seen through Burrow. Only metadata is read (D-006).

const docRef = (id: number) => `paperless:${id}`;

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
    // Burrow's own guess: things whose names share words with the title.
    const guesses = store
      .search(doc.title, 5, { any: true })
      .filter((h) => !linked.some((l) => l.id === h.thing.id))
      .slice(0, 3)
      .map((h) => ({ id: h.thing.id, name: h.thing.name, path: h.thing.path.map((p) => p.name) }));
    res.json({
      doc: decorate(doc, tax, store),
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
    for (const thingId of b.thingIds) {
      store.addEdge("documents", store.mustGet(thingId).id, docRef(id), { title: updated.title });
    }
    res.json({ doc: decorate(updated, tax, store) });
  });

  r.post("/papers/docs/:id/link", (req, res) => {
    const id = Number(req.params.id);
    const b = z.object({ thingId: z.string(), title: z.string().default("") }).parse(req.body);
    store.addEdge("documents", store.mustGet(b.thingId).id, docRef(id), { title: b.title });
    res.json({ things: linkedThings(store, id) });
  });

  r.delete("/papers/docs/:id/link/:thingId", (req, res) => {
    const id = Number(req.params.id);
    store.removeEdge("documents", store.mustGet(req.params.thingId).id, docRef(id));
    res.json({ things: linkedThings(store, id) });
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
  return store
    .edges({ type: "documents", toId: docRef(docId) })
    .map((e) => store.getRaw(e.fromId))
    .filter((t) => t !== null)
    .map((t) => ({ id: t.id, name: t.name }));
}
