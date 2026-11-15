import { Router } from "express";
import { z } from "zod";
import type { Store } from "@burrow/core";
import type { Deps } from "../app.ts";

// Schema as data (D-012): kinds with typed fields, relation types, tags.

const Field = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/, "keys are letters, digits and _"),
  label: z.string().min(1),
  type: z.enum(["text", "longtext", "number", "money", "date", "boolean", "url", "select", "list", "ref"]),
  options: z.array(z.string().min(1)).optional(),
  refKind: z.string().optional(),
  unit: z.string().optional(),
  wanted: z.boolean().optional(),
});

export const KindBody = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/, "ids are lowercase letters, digits, - and _"),
  name: z.string().min(1),
  parent: z.string().nullable().default(null),
  isPlace: z.boolean().default(false),
  physical: z.boolean().default(true),
  fields: z.array(Field).default([]),
});

export const RelationBody = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "ids are lowercase letters, digits and _"),
  name: z.string().min(1),
  inverse: z.string().min(1),
  fromKinds: z.array(z.string()).default([]),
  toKinds: z.array(z.string()).default([]),
  cardinality: z.enum(["one", "many"]).default("many"),
  symmetric: z.boolean().default(false),
});

export function schemaRoutes({ store }: Deps): Router {
  const r = Router();

  r.get("/schema", (_req, res) => {
    const count = (kind: string) =>
      Number(
        (
          store.db
            .prepare("select count(*) n from things where kind = ? and archived_at is null")
            .get(kind) as { n: number }
        ).n,
      );
    const edgeCount = (type: string) =>
      Number((store.db.prepare("select count(*) n from edges where type = ?").get(type) as { n: number }).n);
    res.json({
      kinds: store.kinds().map((k) => ({
        ...k,
        effectiveFields: store.fieldsOf(k.id),
        things: count(k.id),
        // flags derived through inheritance, for the UI
        isTag: store.kindIs(k.id, "tag"),
        isDocument: store.kindIs(k.id, "document"),
      })),
      relations: store.relationTypes().map((rt) => ({ ...rt, links: edgeCount(rt.id) })),
    });
  });

  r.post("/kinds", (req, res) => {
    const b = KindBody.parse(req.body);
    store.defineKind(b);
    res.status(201).json({ kind: store.kind(b.id), effectiveFields: store.fieldsOf(b.id) });
  });

  r.post("/relation-types", (req, res) => {
    const b = RelationBody.parse(req.body);
    store.defineRelation(b);
    res.status(201).json({ relation: store.relationType(b.id) });
  });

  /** All tags with usage counts and nesting, for pickers and the Tags page. */
  r.get("/tags", (_req, res) => res.json({ tags: listTags(store) }));

  /** Merge tags into one (the Tags page's batch action). Undo: the returned events, newest first. */
  r.post("/tags/merge", (req, res) => {
    const b = z.object({ from: z.array(z.string()).min(1).max(500), into: z.string() }).parse(req.body);
    const events = store.mergeTags(b.from, b.into);
    res.json({ tag: store.mustGet(b.into), events });
  });

  return r;
}

export function listTags(store: Store) {
  const rows = store.db
    .prepare(
      `select t.id, t.name, t.parent_id, t.data, (select count(*) from edges e where e.type = 'tagged' and e.to_id = t.id) uses
       from things t where t.archived_at is null and t.kind = 'tag' order by t.name collate nocase`,
    )
    .all() as { id: string; name: string; parent_id: string | null; data: string; uses: number }[];
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    parentId: t.parent_id,
    path: store.path(t.id).map((p) => p.name),
    aliases: (JSON.parse(t.data) as { aliases?: string[] }).aliases ?? [],
    uses: Number(t.uses),
  }));
}
