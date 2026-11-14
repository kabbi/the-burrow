import express, { Router } from "express";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ASSET_ROLES, BurrowError, assetRef, type Asset, type AssetRole } from "@burrow/core";
import type { Deps } from "../app.ts";
import { iconSvg, searchIcons } from "../icons.ts";
import type { Ingested } from "../media.ts";

// Assets (D-015): photos, shop pictures, icons, stylized sprites and 3D models
// attached to a thing. Files live content-addressed in the media dir; the
// store keeps one undoable event per change.

const Role = z.enum(ASSET_ROLES);
const MAX_UPLOAD = 200 * 1024 * 1024;
const MAX_FETCH = 50 * 1024 * 1024;

export const withRef = (a: Asset) => ({ ...a, ...assetRef(a) });

export function assetRoutes({ store, media, sf3d }: Deps): Router {
  const r = Router();
  const raw = express.raw({ type: () => true, limit: MAX_UPLOAD });
  const lastEvent = (thingId: string) => store.events({ thingId, limit: 1 })[0];
  const reply = (thingId: string, extra: Record<string, unknown> = {}) => ({
    assets: store.assets(thingId).map(withRef),
    cover: store.cover(thingId),
    event: lastEvent(thingId),
    ...extra,
  });

  const add = (thingId: string, f: Ingested, role: AssetRole | undefined, extra: Partial<Asset>) => {
    // A model can't be a photo, and an image isn't a model: fix obviously wrong roles.
    const fallback: AssetRole = f.kind === "model" ? "model" : "photo";
    const fit = !role || (role === "model") !== (f.kind === "model") ? fallback : role;
    return store.addAsset(thingId, {
      role: fit,
      file: f.file,
      mime: f.mime,
      bytes: f.bytes,
      ...(f.width ? { width: f.width } : {}),
      ...(f.height ? { height: f.height } : {}),
      ...(f.thumb ? { thumb: f.thumb } : {}),
      ...(extra.label ? { label: extra.label } : {}),
      source: extra.source ?? "you",
      data: extra.data ?? {},
    });
  };

  r.get("/assets/config", async (_req, res) => {
    res.json({ roles: ASSET_ROLES, sf3d: await sf3d.health() });
  });

  r.get("/things/:id/assets", (req, res) => {
    const id = store.mustGet(req.params.id).id;
    res.json({ assets: store.assets(id, { removed: req.query.removed === "1" }).map(withRef) });
  });

  /** Upload one file as the raw request body: ?role=photo&filename=IMG_1.jpg&label=… */
  r.post("/things/:id/assets", raw, async (req, res) => {
    const id = store.mustGet(req.params.id).id;
    const q = z
      .object({
        role: Role.optional(),
        filename: z.string().max(300).optional(),
        label: z.string().max(200).optional(),
      })
      .parse(req.query);
    if (!Buffer.isBuffer(req.body)) throw new BurrowError("Send the file as the request body");
    const f = await media.ingest(req.body, q.filename);
    const a = add(id, f, q.role, {
      ...(q.label ? { label: q.label } : {}),
      data: q.filename ? { filename: q.filename } : {},
    });
    res.status(201).json(reply(id, { asset: withRef(a) }));
  });

  /** Download a picture (or .glb/.stl) from the web, e.g. a shop's product photo. */
  r.post("/things/:id/assets/from-url", async (req, res) => {
    const id = store.mustGet(req.params.id).id;
    const b = z
      .object({ url: z.url({ protocol: /^https?$/ }), role: Role.default("product") })
      .parse(req.body);
    const buf = await download(b.url);
    const f = await media.ingest(buf, new URL(b.url).pathname);
    const a = add(id, f, b.role, { source: "page", data: { url: b.url } });
    res.status(201).json(reply(id, { asset: withRef(a) }));
  });

  r.get("/icons", (req, res) => {
    res.json({ icons: searchIcons(String(req.query.q ?? ""), Math.min(Number(req.query.limit ?? 60), 200)) });
  });

  r.get("/icons/:set/:name.svg", (req, res) => {
    const { svg } = iconSvg(req.params.set, req.params.name);
    res.type("image/svg+xml").setHeader("cache-control", "public, max-age=86400").send(svg);
  });

  r.post("/things/:id/assets/icon", (req, res) => {
    const id = store.mustGet(req.params.id).id;
    const b = z.object({ set: z.string(), name: z.string() }).parse(req.body);
    const { svg, license } = iconSvg(b.set, b.name);
    const buf = Buffer.from(svg);
    const file = media.put(buf, "svg");
    const a = store.addAsset(id, {
      role: "icon",
      file,
      mime: "image/svg+xml",
      bytes: buf.length,
      source: "icons",
      data: license,
    });
    res.status(201).json(reply(id, { asset: withRef(a) }));
  });

  /** Turn a photo into a textured 3D model with Stable Fast 3D (local GPU, free). */
  r.post("/things/:id/assets/generate-model", async (req, res) => {
    const id = store.mustGet(req.params.id).id;
    const b = z.object({ fromAssetId: z.string(), removeBg: z.boolean().default(true) }).parse(req.body);
    const src = store.mustGetAsset(b.fromAssetId);
    if (src.thingId !== id) throw new BurrowError(`${src.id} belongs to ${src.thingId}`);
    if (!src.mime.startsWith("image/") || src.mime === "image/svg+xml")
      throw new BurrowError("Pick a photo to make a 3D model from");
    const input = readFileSync(media.path(src.file));
    const { glb, seconds } = await sf3d.generate(input, src.mime, { removeBg: b.removeBg });
    const f = await media.ingest(glb, "model.glb");
    const a = add(id, f, "model", {
      source: "ai",
      data: { generator: "stable-fast-3d", fromAssetId: src.id, seconds, removeBg: b.removeBg },
    });
    res.status(201).json(reply(id, { asset: withRef(a) }));
  });

  r.patch("/assets/:aid", (req, res) => {
    const b = z
      .object({ role: Role.optional(), label: z.string().max(200).nullable().optional() })
      .parse(req.body);
    const a = store.changeAsset(req.params.aid, {
      ...(b.role ? { role: b.role } : {}),
      ...(b.label !== undefined ? { label: b.label } : {}),
    });
    res.json(reply(a.thingId, { asset: withRef(a) }));
  });

  /**
   * Set a preview picture (raw image body). The web app renders a poster for 3D
   * models in the browser and sends it here; it is shrunk to a thumbnail.
   */
  r.post("/assets/:aid/thumb", raw, async (req, res) => {
    const a = store.mustGetAsset(req.params.aid);
    if (!Buffer.isBuffer(req.body)) throw new BurrowError("Send the picture as the request body");
    const thumb = await media.thumbnail(req.body).catch(() => {
      throw new BurrowError("Not a picture");
    });
    const next = store.changeAsset(a.id, { thumb }, req.query.auto === "1" ? "burrow" : "you");
    res.json(reply(a.thingId, { asset: withRef(next) }));
  });

  r.delete("/assets/:aid", (req, res) => {
    const a = store.mustGetAsset(req.params.aid);
    store.removeAsset(a.id);
    res.json(reply(a.thingId));
  });

  r.post("/things/:id/cover", (req, res) => {
    const id = store.mustGet(req.params.id).id;
    const b = z.object({ assetId: z.string().nullable() }).parse(req.body);
    store.setCover(id, b.assetId);
    res.json(reply(id));
  });

  return r;
}

async function download(url: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Burrow/1.0", accept: "image/*,*/*;q=0.5" },
    });
  } catch (e) {
    throw new BurrowError(`Couldn't download: ${(e as Error).message}`, 502);
  }
  if (!res.ok) throw new BurrowError(`Couldn't download: HTTP ${res.status}`, 502);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_FETCH) throw new BurrowError("That file is too big", 413);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FETCH) throw new BurrowError("That file is too big", 413);
  return buf;
}
