import { extname } from "node:path";
import { z } from "zod";
import {
  ASSET_ROLES,
  BurrowError,
  UNDOABLE,
  assetRef,
  tx,
  type Asset,
  type AssetPatch,
  type FieldSource,
  type ThingView,
} from "@burrow/core";
import type { Deps } from "../app.ts";
import type { Ingested } from "../media.ts";
import { download } from "../routes/assets.ts";
import { KindBody, RelationBody, listTags } from "../routes/schema.ts";
import { op, type AnyOp } from "./define.ts";
import * as S from "./schemas.ts";

// Burrow API v1 (D-020): every core feature an outside system needs, attributed to the token's actor.

const id = z.string().min(1).describe('Thing id ("B-0042" or 42)');
const ThingParams = z.object({ id });
const AssetParams = z.object({ assetId: z.string().min(1).describe('Asset id ("A-0001")') });
const RefParams = z.object({
  service: z.string().regex(/^[a-z][a-z0-9_.-]{0,40}$/, "service: lowercase letters, digits, _ . -"),
  remoteId: z.string().min(1).max(300),
});
const Data = z
  .record(z.string(), z.unknown())
  .describe("Field values by key. Merged into what is there; null removes a key.");
const flag = z
  .enum(["0", "1", "true", "false"])
  .transform((v) => v === "1" || v === "true")
  .optional();

/** Where a thing goes: an id or a path of place names. */
const Placement = {
  parentId: z.string().nullable().optional().describe("Put it inside this place (null: nowhere)."),
  parentPath: z
    .string()
    .max(500)
    .optional()
    .describe('Or name the place by path, e.g. "Garage / Shelf 2" (case-insensitive, / separates).'),
  createPlaces: z
    .boolean()
    .default(false)
    .describe("Create the places of parentPath that don't exist yet (rooms at the top, containers inside)."),
  position: z.string().max(80).nullable().optional().describe('Spot inside the place ("top shelf").'),
};

const Writing = {
  source: S.Source.default("app").describe('Provenance of the values written. Default "app".'),
  tags: z.array(z.string().min(1).max(80)).max(100).optional().describe("Replace the tags with these names."),
  addTags: z
    .array(z.string().min(1).max(80))
    .max(100)
    .optional()
    .describe("Add these tags, keep the others."),
};

const ThingCreate = z.object({
  name: z.string().min(1).max(500),
  kind: z.string().optional().describe('Kind id (default "thing")'),
  data: Data.optional(),
  sources: z.record(z.string(), S.Source).optional().describe("Per-field provenance overrides."),
  ref: z
    .object({ service: RefParams.shape.service, remoteId: RefParams.shape.remoteId, data: Data.optional() })
    .optional()
    .describe("Link it to your own id in the same step."),
  ...Placement,
  ...Writing,
});

const ThingPatch = z.object({
  name: z.string().min(1).max(500).optional(),
  kind: z.string().optional(),
  data: Data.optional(),
  keepYours: z
    .boolean()
    .default(false)
    .describe("Leave fields a person set in Burrow alone (they are listed in `skipped`)."),
  ...Writing,
});

const ThingUpsert = z.object({
  name: z.string().min(1).max(500).optional().describe("Needed when the ref is new."),
  kind: z.string().optional(),
  data: Data.optional(),
  refData: Data.optional().describe("Stored on the ref itself (your own bookkeeping)."),
  keepYours: z
    .boolean()
    .default(true)
    .describe("Leave fields a person set in Burrow alone (default). Skipped ones are listed."),
  ...Placement,
  ...Writing,
});

const AssetMeta = z.object({
  role: z.enum(ASSET_ROLES).optional().describe("Default: photo for pictures, model for .glb/.stl"),
  label: z.string().max(200).optional(),
  key: z
    .string()
    .max(200)
    .optional()
    .describe("Your stable id for this file. Uploading the same key again replaces the file in place."),
  data: Data.optional().describe("Provenance and facts about the file (replaces the stored object)."),
  source: S.Source.default("app"),
});

const ThingReply = z.object({ thing: S.Thing });

export function v1Ops({ store, media }: Deps): AnyOp[] {
  /** Find (or make) the place a path names. */
  const resolvePlace = (path: string, create: boolean, actor: string, source: FieldSource): string => {
    const names = path
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) throw new BurrowError("An empty place path");
    let parent: string | null = null;
    for (const name of names) {
      const here: ThingView | undefined = store
        .list({ parentId: parent, places: true, order: "name", limit: 500 })
        .find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (here) parent = here.id;
      else if (create)
        parent = store.createThing(
          { name, kind: parent ? "container" : "room", parentId: parent, source },
          actor,
        ).id;
      else throw new BurrowError(`No place "${name}" in "${path}"`, 404);
    }
    return parent!;
  };

  const place = (
    b: { parentId?: string | null; parentPath?: string; createPlaces: boolean; source: FieldSource },
    actor: string,
  ) =>
    b.parentPath !== undefined
      ? resolvePlace(b.parentPath, b.createPlaces, actor, b.source)
      : b.parentId === undefined
        ? undefined
        : b.parentId === null
          ? null
          : store.mustGet(b.parentId).id;

  /** Name, kind and data changes, optionally leaving what a person set alone. */
  const change = (
    t: ThingView,
    b: { name?: string; kind?: string; data?: Record<string, unknown>; source: FieldSource },
    keepYours: boolean,
    actor: string,
  ) => {
    const skipped: string[] = [];
    const mine = (k: string) => keepYours && b.source !== "you" && t.meta[k]?.source === "you";
    const patch: { name?: string; kind?: string; data?: Record<string, unknown> } = {};
    for (const k of ["name", "kind"] as const) {
      const v = b[k];
      if (v === undefined || v === t[k]) continue;
      if (mine(k)) skipped.push(k);
      else patch[k] = v;
    }
    if (b.data) {
      const d: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.data)) {
        if (JSON.stringify(t.data[k] ?? null) === JSON.stringify(v ?? null)) continue;
        if (mine(k)) skipped.push(k);
        else d[k] = v;
      }
      if (Object.keys(d).length) patch.data = d;
    }
    if (Object.keys(patch).length) store.change(t.id, patch, b.source, actor);
    return skipped;
  };

  const tags = (
    thingId: string,
    b: { tags?: string[]; addTags?: string[]; source: FieldSource },
    actor: string,
  ) => {
    if (b.tags) store.setTags(thingId, b.tags, b.source, actor);
    for (const name of b.addTags ?? []) {
      const tagId = store.ensureTag(name, actor, null, b.source);
      if (!store.edges({ type: "tagged", fromId: thingId, toId: tagId }).length)
        store.relate("tagged", thingId, tagId, { source: b.source }, actor);
    }
  };

  const noPaperless = (service: string) => {
    // Document refs belong to the paperless link (D-011); apps don't write them.
    if (service === "paperless") throw new BurrowError("paperless refs are managed by Burrow", 403);
  };

  const withRef = (a: Asset) => ({ ...a, ...assetRef(a) });

  const ingestFile = (buf: Buffer, filename: string) =>
    media.ingest(buf, filename).catch((e: Error) => {
      throw new BurrowError(e.message, 415);
    });

  const putAsset = (
    thingId: string,
    f: Ingested,
    original: string | null,
    m: z.infer<typeof AssetMeta>,
    actor: string,
    extra: Record<string, unknown> = {},
  ) => {
    const fallback = f.kind === "model" ? "model" : "photo";
    const role = !m.role || (m.role === "model") !== (f.kind === "model") ? fallback : m.role;
    const existing = m.key ? store.assetByKey(thingId, m.key) : null;
    if (existing) {
      const patch: AssetPatch = {
        file: f.file,
        mime: f.mime,
        bytes: f.bytes,
        width: f.width ?? null,
        height: f.height ?? null,
        thumb: f.thumb ?? null,
        role,
        ...(original !== null ? { original } : {}),
        ...(m.label !== undefined ? { label: m.label } : {}),
        ...(m.data ? { data: { ...m.data, ...extra } } : {}),
      };
      return { asset: store.changeAsset(existing.id, patch, actor), replaced: true };
    }
    const a = store.addAsset(
      thingId,
      {
        role,
        file: f.file,
        mime: f.mime,
        bytes: f.bytes,
        ...(f.width ? { width: f.width } : {}),
        ...(f.height ? { height: f.height } : {}),
        ...(f.thumb ? { thumb: f.thumb } : {}),
        ...(original ? { original } : {}),
        ...(m.key ? { key: m.key } : {}),
        ...(m.label ? { label: m.label } : {}),
        source: m.source,
        data: { ...m.data, ...extra },
      },
      actor,
    );
    return { asset: a, replaced: false };
  };

  const kindView = (k: { id: string }) => ({ ...k, effectiveFields: store.fieldsOf(k.id) });

  return [
    // ------------------------------------------------------------ token
    op({
      method: "get",
      path: "/me",
      id: "whoAmI",
      tag: "Token",
      summary: "The token in use: its actor and scopes",
      scope: "read",
      response: z.object({ token: S.TokenInfo }),
      run: ({ token }) => ({ token }),
    }),

    // ------------------------------------------------------------ things
    op({
      method: "get",
      path: "/things",
      id: "listThings",
      tag: "Things",
      summary: "List things",
      description: "Newest first unless `order=name`. Filters combine.",
      scope: "read",
      query: z.object({
        kind: z.string().optional().describe("Exactly this kind id"),
        parent: z.string().optional().describe('Directly inside this thing; "" = not inside anything'),
        places: flag.describe("1: only places, 0: no places"),
        physical: flag.describe("1: only physical things that aren't places"),
        archived: flag.describe("1: include archived things"),
        order: z.enum(["recent", "name"]).default("recent"),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      response: z.object({ things: z.array(S.Thing) }),
      run: ({ query: q }) => ({
        things: store.list({
          ...(q.kind ? { kind: q.kind } : {}),
          ...(q.parent !== undefined
            ? { parentId: q.parent === "" ? null : store.mustGet(q.parent).id }
            : {}),
          ...(q.places !== undefined ? { places: q.places } : {}),
          ...(q.physical ? { physical: true } : {}),
          ...(q.archived ? { archived: true } : {}),
          order: q.order,
          limit: q.limit,
          offset: q.offset,
        }),
      }),
    }),

    op({
      method: "get",
      path: "/search",
      id: "search",
      tag: "Things",
      summary: "Full-text search",
      description: "Over names, every text field, tag names (with parent tags), refs, ids and place paths.",
      scope: "read",
      query: z.object({
        q: z.string().min(1),
        any: flag.describe("1: match any word instead of all"),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
      response: z.object({ hits: z.array(z.object({ thing: S.Thing, score: z.number() })) }),
      run: ({ query: q }) => ({ hits: store.search(q.q, q.limit, { any: Boolean(q.any) }) }),
    }),

    op({
      method: "get",
      path: "/things/{id}",
      id: "getThing",
      tag: "Things",
      summary: "One thing",
      scope: "read",
      params: ThingParams,
      response: ThingReply,
      run: ({ params }) => ({ thing: store.mustGet(params.id) }),
    }),

    op({
      method: "post",
      path: "/things",
      id: "createThing",
      tag: "Things",
      summary: "Create a thing",
      description: "Optionally placed, tagged and linked to your own id, all in one step (all or nothing).",
      scope: "write",
      status: 201,
      body: ThingCreate,
      response: ThingReply,
      run: ({ body: b, actor }) => {
        if (b.ref) noPaperless(b.ref.service);
        return tx(store.db, () => {
          if (b.ref && store.findRef(b.ref.service, b.ref.remoteId))
            throw new BurrowError(
              `${b.ref.service}:${b.ref.remoteId} is linked already (use PUT /refs/…)`,
              409,
            );
          const parentId = place(b, actor);
          const t = store.createThing(
            {
              name: b.name,
              ...(b.kind ? { kind: b.kind } : {}),
              ...(b.data ? { data: b.data } : {}),
              ...(parentId !== undefined ? { parentId } : {}),
              source: b.source,
              ...(b.sources ? { sources: b.sources } : {}),
            },
            actor,
          );
          if (b.position) store.move(t.id, t.parentId, actor, b.source, b.position);
          tags(t.id, b, actor);
          if (b.ref) store.link(t.id, b.ref.service, b.ref.remoteId, b.ref.data ?? {}, actor);
          return { thing: store.mustGet(t.id) };
        });
      },
    }),

    op({
      method: "patch",
      path: "/things/{id}",
      id: "changeThing",
      tag: "Things",
      summary: "Change a thing's name, kind, fields or tags",
      scope: "write",
      params: ThingParams,
      body: ThingPatch,
      response: z.object({ thing: S.Thing, skipped: z.array(z.string()) }),
      run: ({ params, body: b, actor }) =>
        tx(store.db, () => {
          const t = store.mustGet(params.id);
          const skipped = change(t, b, b.keepYours, actor);
          tags(t.id, b, actor);
          return { thing: store.mustGet(t.id), skipped };
        }),
    }),

    op({
      method: "post",
      path: "/things/{id}/move",
      id: "moveThing",
      tag: "Things",
      summary: "Put a thing somewhere (or nowhere)",
      description:
        "Give `parentId` (null = nowhere) or `parentPath`. Without `position`, the spot is kept when staying and cleared when moving.",
      scope: "write",
      params: ThingParams,
      body: z.object({ ...Placement, source: S.Source.default("app") }),
      response: ThingReply,
      run: ({ params, body: b, actor }) =>
        tx(store.db, () => {
          const t = store.mustGet(params.id);
          const to = place(b, actor);
          if (to === undefined) throw new BurrowError("Give parentId or parentPath");
          store.move(t.id, to, actor, b.source, b.position);
          return { thing: store.mustGet(t.id) };
        }),
    }),

    op({
      method: "post",
      path: "/things/{id}/status",
      id: "setStatus",
      tag: "Things",
      summary: 'Mark a thing ok, unverified or missing ("it\'s not here")',
      scope: "write",
      params: ThingParams,
      body: z.object({
        status: z.enum(["ok", "unverified", "missing"]),
        note: z.string().max(500).optional(),
      }),
      response: ThingReply,
      run: ({ params, body: b, actor }) => ({
        thing: store.setStatus(store.mustGet(params.id).id, b.status, b.note, actor),
      }),
    }),

    op({
      method: "post",
      path: "/things/{id}/confirm",
      id: "confirmFields",
      tag: "Things",
      summary: "Mark guessed fields as checked",
      scope: "write",
      params: ThingParams,
      body: z.object({
        fields: z.array(z.string()).min(1).describe('"name", "kind", "parent" or data keys'),
      }),
      response: ThingReply,
      run: ({ params, body: b, actor }) => ({
        thing: store.confirm(store.mustGet(params.id).id, b.fields, actor),
      }),
    }),

    op({
      method: "post",
      path: "/things/{id}/archive",
      id: "archiveThing",
      tag: "Things",
      summary: "Archive a thing (undo brings it back)",
      scope: "write",
      params: ThingParams,
      response: ThingReply,
      run: ({ params, actor }) => ({ thing: store.archive(store.mustGet(params.id).id, actor) }),
    }),

    op({
      method: "get",
      path: "/things/{id}/children",
      id: "listChildren",
      tag: "Places",
      summary: "What is directly inside a thing",
      scope: "read",
      params: ThingParams,
      response: z.object({ things: z.array(S.Thing) }),
      run: ({ params }) => ({
        things: store.list({ parentId: store.mustGet(params.id).id, order: "name", limit: 500 }),
      }),
    }),

    op({
      method: "get",
      path: "/needs-details",
      id: "needsDetails",
      tag: "Things",
      summary: "Physical things with gaps (no place, or an empty wanted field)",
      scope: "read",
      query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }),
      response: z.object({ things: z.array(S.Thing) }),
      run: ({ query }) => ({ things: store.needsDetails(query.limit) }),
    }),

    op({
      method: "get",
      path: "/stats",
      id: "stats",
      tag: "Things",
      summary: "Counts of things, places, tags, documents and events",
      scope: "read",
      response: z.object({ stats: z.record(z.string(), z.number()) }),
      run: () => ({ stats: store.stats() }),
    }),

    // ------------------------------------------------------------ places
    op({
      method: "get",
      path: "/places",
      id: "listPlaces",
      tag: "Places",
      summary: "Every place with its full path",
      scope: "read",
      response: z.object({ places: z.array(S.Place) }),
      run: () => ({ places: store.places() }),
    }),

    op({
      method: "get",
      path: "/places/tree",
      id: "placeTree",
      tag: "Places",
      summary: "Places with counts of what is inside",
      scope: "read",
      response: z.object({ places: z.array(S.PlaceNode), unplaced: z.number().int() }),
      run: () => store.placeTree(),
    }),

    op({
      method: "post",
      path: "/places/resolve",
      id: "resolvePlace",
      tag: "Places",
      summary: "Find a place by path, optionally creating what is missing",
      scope: "read",
      description: "Needs the `write` scope when `create` is true.",
      body: z.object({ path: z.string().min(1).max(500), create: z.boolean().default(false) }),
      response: z.object({ place: S.Thing }),
      run: ({ body: b, actor, token }) => {
        if (b.create && !token.scopes.includes("write"))
          throw new BurrowError('Creating places needs the "write" scope', 403);
        return { place: store.mustGet(tx(store.db, () => resolvePlace(b.path, b.create, actor, "app"))) };
      },
    }),

    // ------------------------------------------------------------ tags
    op({
      method: "get",
      path: "/tags",
      id: "listTags",
      tag: "Tags",
      summary: "All tags with usage counts and nesting",
      scope: "read",
      response: z.object({ tags: z.array(S.Tag) }),
      run: () => ({ tags: listTags(store) }),
    }),

    op({
      method: "get",
      path: "/tags/{id}/things",
      id: "taggedWith",
      tag: "Tags",
      summary: "Things with this tag (or one nested under it)",
      scope: "read",
      params: ThingParams,
      response: z.object({ things: z.array(S.Thing) }),
      run: ({ params }) => ({ things: store.taggedWith(store.mustGet(params.id).id, 500) }),
    }),

    // ------------------------------------------------------------ links
    op({
      method: "get",
      path: "/things/{id}/relations",
      id: "listRelations",
      tag: "Links",
      summary: "A thing's links, both directions",
      scope: "read",
      params: ThingParams,
      response: z.object({ relations: z.array(S.Relation) }),
      run: ({ params }) => ({ relations: store.relations(store.mustGet(params.id).id) }),
    }),

    op({
      method: "post",
      path: "/relations",
      id: "relate",
      tag: "Links",
      summary: "Link two things",
      description: 'A "one" link type replaces the previous link from the same thing.',
      scope: "write",
      status: 201,
      body: z.object({ type: z.string(), fromId: id, toId: id, data: Data.optional() }),
      response: z.object({ relations: z.array(S.Relation) }),
      run: ({ body: b, actor }) => {
        const from = store.mustGet(b.fromId).id;
        store.relate(b.type, from, store.mustGet(b.toId).id, b.data ?? {}, actor);
        return { relations: store.relations(from) };
      },
    }),

    op({
      method: "delete",
      path: "/relations",
      id: "unrelate",
      tag: "Links",
      summary: "Remove a link",
      scope: "write",
      query: z.object({ type: z.string(), fromId: id, toId: id }),
      response: z.object({ relations: z.array(S.Relation) }),
      run: ({ query: q, actor }) => {
        const from = store.mustGet(q.fromId).id;
        store.unrelate(q.type, from, store.mustGet(q.toId).id, actor);
        return { relations: store.relations(from) };
      },
    }),

    // ------------------------------------------------------------ refs
    op({
      method: "get",
      path: "/refs/{service}/{remoteId}",
      id: "getByRef",
      tag: "Refs",
      summary: "The thing linked to your id",
      scope: "read",
      params: RefParams,
      response: z.object({ ref: S.Ref, thing: S.Thing }),
      run: ({ params }) => {
        const ref = store.findRef(params.service, params.remoteId);
        if (!ref) throw new BurrowError(`Nothing is linked to ${params.service}:${params.remoteId}`, 404);
        return { ref, thing: store.mustGet(ref.thingId) };
      },
    }),

    op({
      method: "put",
      path: "/refs/{service}/{remoteId}",
      id: "upsertByRef",
      tag: "Refs",
      summary: "Create or update the thing linked to your id",
      description:
        "The way to sync. New ref: creates the thing (`name` needed) and links it. Known ref: changes only what you send; fields a person set in Burrow are kept unless `keepYours: false`. It is only moved when you send a place.",
      scope: "write",
      params: RefParams,
      body: ThingUpsert,
      response: z.object({ thing: S.Thing, created: z.boolean(), skipped: z.array(z.string()) }),
      run: ({ params: p, body: b, actor }) => {
        noPaperless(p.service);
        return tx(store.db, () => {
          const ref = store.findRef(p.service, p.remoteId);
          const parentId = place(b, actor);
          if (!ref || !store.getRaw(ref.thingId)) {
            if (!b.name) throw new BurrowError("name is needed to create the thing");
            const t = store.createThing(
              {
                name: b.name,
                ...(b.kind ? { kind: b.kind } : {}),
                ...(b.data ? { data: b.data } : {}),
                ...(parentId !== undefined ? { parentId } : {}),
                source: b.source,
              },
              actor,
            );
            if (b.position) store.move(t.id, t.parentId, actor, b.source, b.position);
            tags(t.id, b, actor);
            store.link(t.id, p.service, p.remoteId, b.refData ?? {}, actor);
            return { thing: store.mustGet(t.id), created: true, skipped: [] };
          }
          const t = store.mustGet(ref.thingId);
          const skipped = change(t, b, b.keepYours, actor);
          if (parentId !== undefined) {
            if (
              b.keepYours &&
              b.source !== "you" &&
              t.meta.parent?.source === "you" &&
              parentId !== t.parentId
            )
              skipped.push("parent");
            else store.move(t.id, parentId, actor, b.source, b.position);
          }
          tags(t.id, b, actor);
          if (b.refData && JSON.stringify(b.refData) !== JSON.stringify(ref.data))
            store.link(t.id, p.service, p.remoteId, b.refData, actor);
          return { thing: store.mustGet(t.id), created: false, skipped };
        });
      },
    }),

    op({
      method: "get",
      path: "/refs",
      id: "listRefs",
      tag: "Refs",
      summary: "All refs of one service",
      scope: "read",
      query: z.object({ service: RefParams.shape.service }),
      response: z.object({ refs: z.array(S.Ref) }),
      run: ({ query }) => ({ refs: store.refsByService(query.service) }),
    }),

    op({
      method: "post",
      path: "/things/{id}/refs",
      id: "linkRef",
      tag: "Refs",
      summary: "Link a thing to an id in another system",
      description: "An id can only point at one thing: linking it again moves it here.",
      scope: "write",
      status: 201,
      params: ThingParams,
      body: z.object({
        service: RefParams.shape.service,
        remoteId: RefParams.shape.remoteId,
        data: Data.optional(),
      }),
      response: ThingReply,
      run: ({ params, body: b, actor }) => {
        noPaperless(b.service);
        const t = store.mustGet(params.id);
        store.link(t.id, b.service, b.remoteId, b.data ?? {}, actor);
        return { thing: store.mustGet(t.id) };
      },
    }),

    op({
      method: "delete",
      path: "/things/{id}/refs/{service}/{remoteId}",
      id: "unlinkRef",
      tag: "Refs",
      summary: "Remove a link to another system",
      scope: "write",
      params: z.object({ id, ...RefParams.shape }),
      response: ThingReply,
      run: ({ params: p, actor }) => {
        noPaperless(p.service);
        const t = store.mustGet(p.id);
        const ref = store.findRef(p.service, p.remoteId);
        if (!ref || ref.thingId !== t.id)
          throw new BurrowError(`${t.id} has no ref ${p.service}:${p.remoteId}`, 404);
        store.unlink(t.id, p.service, p.remoteId, actor);
        return { thing: store.mustGet(t.id) };
      },
    }),

    // ------------------------------------------------------------ assets
    op({
      method: "get",
      path: "/things/{id}/assets",
      id: "listAssets",
      tag: "Assets",
      summary: "A thing's pictures and models",
      scope: "read",
      params: ThingParams,
      query: z.object({ removed: flag.describe("1: include removed ones") }),
      response: z.object({ assets: z.array(S.Asset), coverId: z.string().nullable() }),
      run: ({ params, query }) => {
        const t = store.mustGet(params.id);
        return {
          assets: store.assets(t.id, { removed: Boolean(query.removed) }).map(withRef),
          coverId: store.coverAsset(t.id)?.id ?? null,
        };
      },
    }),

    op({
      method: "get",
      path: "/assets/{assetId}",
      id: "getAsset",
      tag: "Assets",
      summary: "One asset",
      scope: "read",
      params: AssetParams,
      response: z.object({ asset: S.Asset }),
      run: ({ params }) => ({ asset: withRef(store.mustGetAsset(params.assetId)) }),
    }),

    op({
      method: "post",
      path: "/things/{id}/assets",
      id: "uploadAsset",
      tag: "Assets",
      summary: "Upload a picture or 3D model (multipart)",
      description:
        "Parts: `file`, optionally `original` (the untouched source, e.g. a camera raw), and `meta` (JSON). With `meta.key`, uploading again replaces that asset's file in place (it keeps its id and cover status).",
      scope: "write",
      status: 201,
      params: ThingParams,
      multipart: {
        files: {
          file: {
            required: true,
            description: "The picture (jpeg, png, webp, gif, svg…) or model (.glb, .stl)",
          },
          original: { required: false, description: "The source file this one was made from, kept as-is" },
        },
        meta: AssetMeta,
      },
      response: z.object({ asset: S.Asset, replaced: z.boolean() }),
      run: async ({ params, body, files, actor }) => {
        const t = store.mustGet(params.id);
        const m = body as z.infer<typeof AssetMeta>;
        const f = await ingestFile(files.file!.data, files.file!.filename);
        const o = files.original;
        const original = o
          ? media.put(o.data, (extname(o.filename).slice(1) || "bin").toLowerCase().replace(/[^a-z0-9]/g, ""))
          : null;
        const out = putAsset(t.id, f, original, m, actor, { filename: files.file!.filename });
        return { asset: withRef(out.asset), replaced: out.replaced };
      },
    }),

    op({
      method: "post",
      path: "/things/{id}/assets/from-url",
      id: "assetFromUrl",
      tag: "Assets",
      summary: "Download a picture or model from the web",
      scope: "write",
      status: 201,
      params: ThingParams,
      body: AssetMeta.extend({
        url: z.url({ protocol: /^https?$/ }),
        role: z.enum(ASSET_ROLES).default("product"),
        source: S.Source.default("page"),
      }),
      response: z.object({ asset: S.Asset, replaced: z.boolean() }),
      run: async ({ params, body: b, actor }) => {
        const t = store.mustGet(params.id);
        const f = await ingestFile(await download(b.url), new URL(b.url).pathname);
        const out = putAsset(t.id, f, null, b, actor, { url: b.url });
        return { asset: withRef(out.asset), replaced: out.replaced };
      },
    }),

    op({
      method: "patch",
      path: "/assets/{assetId}",
      id: "changeAsset",
      tag: "Assets",
      summary: "Change an asset's role, label, key or data",
      scope: "write",
      params: AssetParams,
      body: z.object({
        role: z.enum(ASSET_ROLES).optional(),
        label: z.string().max(200).nullable().optional(),
        key: z.string().max(200).nullable().optional(),
        data: Data.optional().describe("Replaces the stored object"),
      }),
      response: z.object({ asset: S.Asset }),
      run: ({ params, body: b, actor }) => {
        const patch: AssetPatch = {};
        if (b.role) patch.role = b.role;
        if (b.label !== undefined) patch.label = b.label;
        if (b.key !== undefined) patch.key = b.key;
        if (b.data) patch.data = b.data;
        return { asset: withRef(store.changeAsset(store.mustGetAsset(params.assetId).id, patch, actor)) };
      },
    }),

    op({
      method: "delete",
      path: "/assets/{assetId}",
      id: "removeAsset",
      tag: "Assets",
      summary: "Remove an asset (undo brings it back)",
      scope: "write",
      params: AssetParams,
      response: z.object({ assets: z.array(S.Asset) }),
      run: ({ params, actor }) => {
        const a = store.mustGetAsset(params.assetId);
        store.removeAsset(a.id, actor);
        return { assets: store.assets(a.thingId).map(withRef) };
      },
    }),

    op({
      method: "post",
      path: "/things/{id}/cover",
      id: "setCover",
      tag: "Assets",
      summary: "Choose the cover picture (null: pick automatically)",
      scope: "write",
      params: ThingParams,
      body: z.object({ assetId: z.string().nullable() }),
      response: ThingReply,
      run: ({ params, body: b, actor }) => ({
        thing: store.setCover(store.mustGet(params.id).id, b.assetId, actor),
      }),
    }),

    // ------------------------------------------------------------ schema
    op({
      method: "get",
      path: "/schema",
      id: "getSchema",
      tag: "Schema",
      summary: "All kinds (with inherited fields) and link types",
      scope: "read",
      response: z.object({ kinds: z.array(S.Kind), relationTypes: z.array(S.RelationType) }),
      run: () => ({ kinds: store.kinds().map(kindView), relationTypes: store.relationTypes() }),
    }),

    op({
      method: "put",
      path: "/kinds/{kindId}",
      id: "defineKind",
      tag: "Schema",
      summary: "Define or redefine a kind",
      description: "Redefining replaces the kind's own fields; existing values stay in the things' data.",
      scope: "schema",
      params: z.object({ kindId: KindBody.shape.id }),
      body: KindBody.omit({ id: true }),
      response: z.object({ kind: S.Kind }),
      run: ({ params, body: b, actor }) => {
        store.defineKind({ id: params.kindId, ...b }, actor);
        return { kind: kindView(store.kind(params.kindId)!) };
      },
    }),

    op({
      method: "put",
      path: "/relation-types/{typeId}",
      id: "defineRelationType",
      tag: "Schema",
      summary: "Define or redefine a link type",
      scope: "schema",
      params: z.object({ typeId: RelationBody.shape.id }),
      body: RelationBody.omit({ id: true }),
      response: z.object({ relationType: S.RelationType }),
      run: ({ params, body: b, actor }) => {
        store.defineRelation({ id: params.typeId, ...b }, actor);
        return { relationType: store.relationType(params.typeId)! };
      },
    }),

    // ------------------------------------------------------------ history
    op({
      method: "get",
      path: "/events",
      id: "listEvents",
      tag: "History",
      summary: "The event log",
      description:
        "Newest first; with `after`, the events after that seq oldest first (poll with the last seq you saw to follow changes). Undo events are left out unless `undos=1`.",
      scope: "read",
      query: z.object({
        after: z.coerce.number().int().min(0).optional(),
        thingId: z.string().optional(),
        types: z.string().optional().describe("Comma-separated event types"),
        actor: z.string().optional(),
        undos: flag,
        limit: z.coerce.number().int().min(1).max(500).default(50),
      }),
      response: z.object({ events: z.array(S.Event) }),
      run: ({ query: q }) => ({
        events: store.events({
          ...(q.after !== undefined ? { after: q.after } : {}),
          ...(q.thingId ? { thingId: store.mustGet(q.thingId).id } : {}),
          ...(q.types ? { types: q.types.split(",").map((s) => s.trim()) } : {}),
          ...(q.actor ? { actor: q.actor } : {}),
          includeUndos: Boolean(q.undos),
          limit: q.limit,
        }),
      }),
    }),

    op({
      method: "post",
      path: "/events/{seq}/undo",
      id: "undo",
      tag: "History",
      summary: "Undo one of this token's changes (again = redo)",
      description:
        "Appends the inverse event; history is never rewritten. Apps can only undo what their own actor did.",
      scope: "write",
      params: z.object({ seq: z.coerce.number().int().min(1) }),
      response: z.object({ undo: S.Event }),
      run: ({ params, actor }) => {
        const e = store.event(params.seq);
        if (!e) throw new BurrowError(`No event ${params.seq}`, 404);
        const original = e.undoOf ? store.event(e.undoOf) : e;
        if (original?.actor !== actor)
          throw new BurrowError(`Event ${params.seq} isn't ${actor}'s to undo`, 403);
        if (!UNDOABLE.has(original.body.type)) throw new BurrowError(`${original.body.type} can't be undone`);
        return { undo: store.toggleUndo(params.seq, actor) };
      },
    }),
  ];
}
