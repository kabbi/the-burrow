import { Router } from "express";
import { z } from "zod";
import { UNDOABLE, type FieldSource, type Store } from "@burrow/core";
import type { Deps } from "../app.ts";
import { fetchPreview } from "../link-preview.ts";
import { ThingSuggestion } from "../ai/tasks.ts";

const Source = z.enum(["you", "ai", "page", "file", "homebox", "paperless", "import"]);
const Data = z.record(z.string(), z.unknown());

const CreateBody = z.object({
  name: z.string().min(1).max(500),
  kind: z.string().optional(),
  parentId: z.string().nullable().optional(),
  data: Data.optional(),
  source: Source.optional(),
  sources: z.record(z.string(), Source).optional(),
});

const PatchBody = z.object({
  name: z.string().min(1).max(500).optional(),
  kind: z.string().optional(),
  data: Data.optional(),
  source: Source.optional(),
});

export function thingRoutes({ store, ai }: Deps): Router {
  const r = Router();

  r.get("/search", (req, res) => {
    const q = String(req.query.q ?? "");
    res.json({ hits: store.search(q, Number(req.query.limit ?? 20)) });
  });

  r.get("/things", (req, res) => {
    const q = req.query;
    res.json({
      things: store.list({
        ...(q.kind ? { kind: String(q.kind) } : {}),
        ...(q.parent !== undefined ? { parentId: q.parent === "" ? null : String(q.parent) } : {}),
        ...(q.places !== undefined ? { places: q.places === "1" } : {}),
        limit: Math.min(Number(q.limit ?? 100), 500),
        offset: Number(q.offset ?? 0),
        order: q.order === "name" ? "name" : "recent",
      }),
    });
  });

  r.get("/things/:id", (req, res) => {
    const t = store.mustGet(req.params.id);
    res.json({
      thing: t,
      children: store.list({ parentId: t.id, order: "name", limit: 500 }),
      events: store
        .events({ thingId: t.id, limit: 50 })
        .map((e) => ({ ...e, undoable: UNDOABLE.has(e.body.type) })),
      documents: store.edges({ type: "documents", fromId: t.id }),
    });
  });

  r.post("/things", (req, res) => {
    const b = CreateBody.parse(req.body);
    const t = store.createThing({
      name: b.name,
      ...(b.kind ? { kind: b.kind } : {}),
      ...(b.parentId !== undefined ? { parentId: b.parentId } : {}),
      ...(b.data ? { data: b.data } : {}),
      ...(b.source ? { source: b.source } : {}),
      ...(b.sources ? { sources: b.sources } : {}),
    });
    res.status(201).json({ thing: t, event: store.events({ thingId: t.id, limit: 1 })[0] });
  });

  r.patch("/things/:id", (req, res) => {
    const b = PatchBody.parse(req.body);
    const t = store.change(
      req.params.id,
      {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.kind !== undefined ? { kind: b.kind } : {}),
        ...(b.data ? { data: b.data } : {}),
      },
      b.source ?? "you",
    );
    res.json({ thing: t, event: store.events({ thingId: t.id, limit: 1 })[0] });
  });

  r.post("/things/:id/move", (req, res) => {
    const { to } = z.object({ to: z.string().nullable() }).parse(req.body);
    const t = store.move(req.params.id, to);
    // Putting something somewhere by hand means you know where it is.
    if (t.status === "missing") store.setStatus(t.id, "ok", "placed by hand");
    res.json({
      thing: store.mustGet(t.id),
      event: store.events({ thingId: t.id, types: ["thing.moved"], limit: 1 })[0],
    });
  });

  r.post("/things/:id/status", (req, res) => {
    const b = z
      .object({ status: z.enum(["ok", "unverified", "missing"]), note: z.string().max(500).optional() })
      .parse(req.body);
    const t = store.setStatus(req.params.id, b.status, b.note);
    res.json({ thing: t, event: store.events({ thingId: t.id, limit: 1 })[0] });
  });

  r.post("/things/:id/confirm", (req, res) => {
    const { fields } = z.object({ fields: z.array(z.string()).min(1) }).parse(req.body);
    res.json({ thing: store.confirm(req.params.id, fields) });
  });

  r.post("/things/:id/archive", (req, res) => {
    const t = store.archive(req.params.id);
    res.json({ thing: t, event: store.events({ thingId: t.id, limit: 1 })[0] });
  });

  /**
   * Apply a finished AI suggestion. Accepted by default (design rule): every
   * field lands with source "ai" except the ones listed in `reject`. Fields a
   * person already set are never overwritten.
   */
  r.post("/things/:id/apply-suggestion", (req, res) => {
    const b = z.object({ requestId: z.string(), reject: z.array(z.string()).default([]) }).parse(req.body);
    const rec = ai.get(b.requestId);
    if (!rec || rec.status !== "done") return res.status(409).json({ error: "Suggestion is not ready" });
    const s = ThingSuggestion.parse(rec.result);
    res.json({ thing: applySuggestion(store, req.params.id, s, new Set(b.reject)) });
  });

  r.get("/places", (_req, res) => res.json({ places: store.places() }));

  r.get("/kinds", (_req, res) => res.json({ kinds: store.kinds() }));

  r.post("/kinds", (req, res) => {
    const b = z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
        name: z.string().min(1),
        isPlace: z.boolean().default(false),
        fields: z
          .array(
            z.object({
              key: z.string(),
              label: z.string(),
              type: z.enum(["text", "number", "tags", "url", "date", "money"]),
              wanted: z.boolean().optional(),
            }),
          )
          .default([]),
      })
      .parse(req.body);
    store.defineKind(b);
    res.status(201).json({ kind: store.kind(b.id) });
  });

  r.get("/events", (req, res) => {
    const types = req.query.types ? String(req.query.types).split(",") : undefined;
    res.json({
      events: store
        .events({ ...(types ? { types } : {}), limit: Number(req.query.limit ?? 30) })
        .map((e) => ({ ...e, undoable: UNDOABLE.has(e.body.type), thing: thingName(store, e.body) })),
    });
  });

  r.post("/events/:seq/undo", (req, res) => {
    const e = store.toggleUndo(Number(req.params.seq));
    res.json({
      event: e,
      original: store.events({ limit: 200 }).find((x) => x.seq === Number(req.params.seq)),
    });
  });

  r.get("/needs-details", (_req, res) => res.json({ things: store.needsDetails(200) }));

  r.post("/preview", async (req, res) => {
    const { url } = z.object({ url: z.url() }).parse(req.body);
    try {
      res.json({ preview: await fetchPreview(url) });
    } catch (e) {
      res.json({ preview: null, error: (e as Error).message });
    }
  });

  return r;
}

function thingName(store: Store, body: { type: string } & Record<string, unknown>) {
  const id = (body.id ?? body.thingId ?? body.fromId) as string | undefined;
  const t = id ? store.getRaw(id) : null;
  if (!t) return null;
  const nameOf = (x: unknown) => (typeof x === "string" ? (store.getRaw(x)?.name ?? x) : null);
  return { id: t.id, name: t.name, from: nameOf(body.from), to: nameOf(body.to) };
}

export function applySuggestion(store: Store, id: string, s: ThingSuggestion, reject: Set<string>) {
  const t = store.mustGet(id);
  const mine = (k: string) => t.meta[k]?.source === "you" && k !== "name";
  const data: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (reject.has(k) || mine(k) || v === null || v === undefined || v === "") return;
    if (Array.isArray(v) && !v.length) return;
    data[k] = v;
  };
  put("description", s.description);
  put("tags", s.tags.map((x) => x.toLowerCase().trim()).filter(Boolean));
  put("maker", s.maker);
  put("model", s.model);
  if (s.quantity !== null && s.quantity > 1) put("quantity", s.quantity);
  const patch: { name?: string; kind?: string; data: Record<string, unknown> } = { data };
  if (!reject.has("name") && s.name && s.name !== t.name) patch.name = s.name;
  // Models sometimes answer with the kind's label ("Tool") instead of its id.
  const kind = store
    .kinds()
    .find((k) => k.id === s.kind || k.name.toLowerCase() === s.kind.toLowerCase())?.id;
  if (!reject.has("kind") && !mine("kind") && kind && kind !== t.kind) patch.kind = kind;
  const desc = s.description.trim();
  if (desc.toLowerCase() === s.name.toLowerCase() || desc.toLowerCase() === t.name.toLowerCase())
    delete data.description;
  const source: FieldSource = "ai";
  store.change(id, patch, source, "ai");
  if (!reject.has("parent") && s.placeId && !t.parentId && store.getRaw(s.placeId)) {
    store.move(id, s.placeId, "ai", "ai");
  }
  return store.mustGet(id);
}
