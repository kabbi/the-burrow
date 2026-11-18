import express, { Router } from "express";
import { z } from "zod";
import { UNDOABLE, type FieldSource, type Store } from "@burrow/core";
import type { Deps } from "../app.ts";
import { BlockedError, fetchPreview, parsePreview, rememberCapture } from "../link-preview.ts";
import { ThingSuggestion } from "../ai/tasks.ts";
import { withRef } from "./assets.ts";
import { findDuplicates } from "../duplicates.ts";

const Source = z.enum(["you", "ai", "page", "file", "homebox", "paperless", "import"]);
const Data = z.record(z.string(), z.unknown());

const CreateBody = z.object({
  name: z.string().min(1).max(500),
  kind: z.string().optional(),
  parentId: z.string().nullable().optional(),
  /** No fixed place (D-026); only without a parent. */
  roams: z.boolean().optional(),
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

export function thingRoutes({ store, ai, vision }: Deps): Router {
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
        ...(q.roams !== undefined ? { roams: q.roams === "1" } : {}),
        limit: Math.min(Number(q.limit ?? 100), 500),
        offset: Number(q.offset ?? 0),
        order: q.order === "name" ? "name" : "recent",
      }),
    });
  });

  r.get("/things/:id", (req, res) => {
    const t = store.mustGet(req.params.id);
    const paperlessOf = (id: string) =>
      store.refsOf(id).find((x) => x.service === "paperless")?.remoteId ?? null;
    res.json({
      thing: t,
      fields: store.fieldsOf(t.kind),
      children: store.list({ parentId: t.id, order: "name", limit: 500 }),
      relations: store.relations(t.id).map((rel) => ({
        ...rel,
        paperlessId: rel.type === "has_document" ? paperlessOf(rel.other.id) : null,
      })),
      tagged: store.kindIs(t.kind, "tag") ? store.taggedWith(t.id, 500) : [],
      assets: store.assets(t.id).map(withRef),
      coverId: store.coverId(t.id),
      /** Spots already used in this thing's place, for suggestions. */
      spots: t.parentId ? store.positionsIn(t.parentId) : [],
      paperlessId: paperlessOf(t.id),
      /** The other live things of the same stock (D-036), and where a combined one went. */
      stock: t.archivedAt ? [] : store.stockFamily(t.id),
      mergedInto: t.archivedAt ? (store.edges({ type: "merged_into", fromId: t.id })[0]?.toId ?? null) : null,
      events: store
        .events({ thingId: t.id, limit: 50 })
        .map((e) => ({ ...e, undoable: UNDOABLE.has(e.body.type) })),
    });
  });

  /** Replace a thing's tags with these names (new ones are created). */
  r.put("/things/:id/tags", (req, res) => {
    const b = z.object({ names: z.array(z.string().min(1).max(80)).max(100) }).parse(req.body);
    res.json({ thing: store.setTags(req.params.id, b.names, "you") });
  });

  /** Mark an AI-attached tag as checked by a person. */
  r.post("/things/:id/tags/:tagId/confirm", (req, res) => {
    store.relate("tagged", req.params.id, req.params.tagId, { source: "you" });
    res.json({ thing: store.mustGet(req.params.id) });
  });

  const RelBody = z.object({
    type: z.string(),
    otherId: z.string(),
    /** out: this thing → other; in: other → this thing. */
    direction: z.enum(["out", "in"]).default("out"),
  });

  r.post("/things/:id/relations", (req, res) => {
    const b = RelBody.parse(req.body);
    const me = store.mustGet(req.params.id).id;
    const other = store.mustGet(b.otherId).id;
    if (b.direction === "out") store.relate(b.type, me, other);
    else store.relate(b.type, other, me);
    res.status(201).json({ relations: store.relations(me), event: store.events({ limit: 1 })[0] });
  });

  r.delete("/things/:id/relations", (req, res) => {
    const b = RelBody.parse(req.body);
    const me = store.mustGet(req.params.id).id;
    const other = store.mustGet(b.otherId).id;
    if (b.direction === "out") store.unrelate(b.type, me, other);
    else store.unrelate(b.type, other, me);
    res.json({ relations: store.relations(me), event: store.events({ limit: 1 })[0] });
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
    if (b.roams && !b.parentId) store.move(t.id, null, undefined, undefined, undefined, true);
    res.status(201).json({
      thing: store.mustGet(t.id),
      event: store.events({ thingId: t.id, types: ["thing.created"], limit: 1 })[0],
    });
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
    const b = z
      .object({
        to: z.string().nullable(),
        /** Spot inside `to` ("shelf 3"); omitted = keep when staying, clear when moving. */
        position: z.string().max(80).nullable().optional(),
        /** With `to: null`: no fixed place (D-026) instead of "not placed yet". */
        roams: z.boolean().optional(),
      })
      .parse(req.body);
    const t = store.move(req.params.id, b.to, undefined, undefined, b.position, b.roams ?? false);
    // Putting something somewhere by hand means you know where it is.
    if (t.status === "missing") store.setStatus(t.id, "ok", "placed by hand");
    res.json({
      thing: store.mustGet(t.id),
      event: store.events({ thingId: t.id, types: ["thing.moved"], limit: 1 })[0],
    });
  });

  /** Stock (D-036): the other live things split off the same one. */
  r.get("/things/:id/stock", (req, res) => res.json({ family: store.stockFamily(req.params.id) }));

  /** Take `count` out as a new thing, in `to` (omitted: next to it). Undo: the events, newest first. */
  r.post("/things/:id/split", (req, res) => {
    const b = z
      .object({
        count: z.number().int().min(1),
        to: z.string().nullable().optional(),
        position: z.string().max(80).nullable().optional(),
        roams: z.boolean().optional(),
      })
      .parse(req.body);
    const { thing, events } = store.split(req.params.id, b.count, {
      ...(b.to !== undefined ? { to: b.to } : {}),
      ...(b.position !== undefined ? { position: b.position } : {}),
      ...(b.roams ? { roams: true } : {}),
    });
    res.status(201).json({ thing, events });
  });

  /** Another one of it (D-038): a copy without its contents, next to it or in `to`. */
  r.post("/things/:id/duplicate", (req, res) => {
    const b = z
      .object({ name: z.string().max(200).optional(), to: z.string().nullable().optional() })
      .parse(req.body ?? {});
    const { thing, events } = store.duplicate(req.params.id, {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.to !== undefined ? { to: b.to } : {}),
    });
    res.status(201).json({ thing, events });
  });

  /** Put `from` back into this one (all of them, or `count` of a single one). */
  r.post("/things/:id/combine", (req, res) => {
    const b = z
      .object({ from: z.array(z.string()).min(1).max(100), count: z.number().int().min(1).optional() })
      .parse(req.body);
    const events = store.combine(b.from, req.params.id, b.count !== undefined ? { count: b.count } : {});
    res.json({ thing: store.mustGet(req.params.id), events });
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
    const t = store.confirm(req.params.id, fields);
    res.json({ thing: t, event: store.events({ thingId: t.id, limit: 1 })[0] });
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
  r.get("/places/tree", (_req, res) => res.json(store.placeTree()));

  r.get("/kinds", (_req, res) => res.json({ kinds: store.kinds() }));

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
  /** Thing of the day (D-028). `day` is the viewer's local date, so the pick changes at their midnight. */
  r.get("/today", (req, res) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day))
      ? String(req.query.day)
      : new Date().toISOString().slice(0, 10);
    res.json({ day, picks: store.thingsOfTheDay(day) });
  });
  /** Tidy up: gaps, unchecked AI guesses and things you may have twice, for grouping into jobs. */
  r.get("/tidy", (_req, res) =>
    res.json({
      gaps: store.needsDetails(1000),
      aiChecks: store.aiUnchecked(500),
      duplicates: findDuplicates(store, vision),
    }),
  );

  r.post("/preview", async (req, res) => {
    const { url } = z.object({ url: z.url() }).parse(req.body);
    try {
      res.json({ preview: await fetchPreview(url) });
    } catch (e) {
      res.json({ preview: null, error: (e as Error).message, blocked: e instanceof BlockedError });
    }
  });

  // The "Send to Burrow" bookmarklet (D-024) form-POSTs the page's head (meta tags, JSON-LD) as read
  // in your browser, for shops whose anti-bot blocks /preview. Remembered for /preview, then on to Add.
  r.post("/capture", express.urlencoded({ extended: false, limit: "3mb" }), (req, res) => {
    const { url, html } = z
      .object({ url: z.url({ protocol: /^https?$/ }), html: z.string().max(3_000_000) })
      .parse(req.body);
    const preview = parsePreview(html, url);
    rememberCapture(preview);
    res.redirect(303, `/add?name=${encodeURIComponent(preview.url)}`);
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

export function applySuggestion(
  store: Store,
  id: string,
  s: Omit<ThingSuggestion, "question">,
  reject: Set<string>,
) {
  const t = store.mustGet(id);
  const mine = (k: string) => t.meta[k]?.source === "you" && k !== "name";
  const data: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (reject.has(k) || mine(k) || v === null || v === undefined || v === "") return;
    if (Array.isArray(v) && !v.length) return;
    data[k] = v;
  };
  put("description", s.description);
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
  // The person who asked for (or kept) the guess is the actor; the values stay "ai" (violet).
  store.change(id, patch, source);
  // No AI tags (D-030): tags carry human meaning a product page can't tell.
  if (!reject.has("parent") && s.placeId && !t.parentId && store.getRaw(s.placeId)) {
    store.move(id, s.placeId, undefined, "ai");
  }
  return store.mustGet(id);
}
