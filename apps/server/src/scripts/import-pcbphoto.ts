// One-off, idempotent backfill from pcb-photo-maker's library (D-018), read-only on its side:
//  1. defines the "pcb" kind (extends electronics: slug, revision, width/height in mm)
//  2. every processed top/bottom capture → a photo asset with its camera original, side, scale and size
//     (key "pcbphoto:<capture id>"; the top photo HomeBox gave us is upgraded in place, so it stays the cover)
//  3. things that were HomeBox "PCB" entities → kind pcb; hb_slug/hb_revision/hb_*_mm → proper fields
// Captures are matched to things through the HomeBox entity id kept by the import (D-010).
//
//   pnpm --filter @burrow/server import:pcbphoto [--dry-run]
//   PCBPHOTO_LIBRARY=/path/to/library (default ~/dev/js/pcb-photo-maker/library)
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, type AssetPatch } from "@burrow/core";
import { config } from "../config.ts";
import { aiMigrations } from "../ai/gateway.ts";
import { Media } from "../media.ts";

const ACTOR = "pcbphoto-import";
const DRY = process.argv.includes("--dry-run");
const LIB = process.env.PCBPHOTO_LIBRARY ?? join(homedir(), "dev/js/pcb-photo-maker/library");
if (!existsSync(join(LIB, "library.sqlite"))) throw new Error(`No pcb-photo-maker library at ${LIB}`);

const store = Store.open(config.db, aiMigrations);
const media = new Media(config.mediaDir);
const rig = new DatabaseSync(join(LIB, "library.sqlite"), { readOnly: true });

if (!DRY) {
  const backups = join(dirname(config.db), "backups");
  mkdirSync(backups, { recursive: true });
  const backup = join(
    backups,
    `burrow-${new Date().toISOString().replace(/[:.]/g, "-")}-before-pcbphoto.sqlite`,
  );
  store.db.exec(`vacuum into '${backup.replace(/'/g, "''")}'`);
  console.log("backup:", backup);
}

// --- 1. the PCB kind (schema as data, D-012)
if (!store.kind("pcb") && !DRY)
  store.defineKind(
    {
      id: "pcb",
      name: "PCB",
      parent: "electronics",
      isPlace: false,
      physical: true,
      fields: [
        { key: "slug", label: "Slug", type: "text" },
        { key: "revision", label: "Revision", type: "text" },
        { key: "width_mm", label: "Width", type: "number", unit: "mm" },
        { key: "height_mm", label: "Height", type: "number", unit: "mm" },
      ],
    },
    ACTOR,
  );

// --- 2. captures → assets
interface Capture {
  id: string;
  item_id: string;
  side: "top" | "bottom";
  rotate90: number;
  width_mm: number | null;
  height_mm: number | null;
  camera_file: string | null;
  calib_id: string | null;
  created_at: string;
  meta: string | null;
}
const caps = rig
  .prepare(
    `select id, item_id, side, rotate90, width_mm, height_mm, camera_file, calib_id, created_at, meta from captures
     where item_id is not null and side in ('top', 'bottom') and status = 'done'
     order by item_id, side desc, created_at`,
  )
  .all() as unknown as Capture[];

const report = {
  captures: caps.length,
  added: 0,
  upgraded: 0,
  updated: 0,
  unchanged: 0,
  noThing: 0,
  noFile: 0,
  originals: 0,
};
const sizeOf = new Map<string, { w: number; h: number }>(); // thing → top board size

for (const c of caps) {
  const thingId = store.findRef("homebox", c.item_id)?.thingId;
  if (!thingId) {
    report.noThing++;
    console.warn(`capture ${c.id}: no thing for HomeBox entity ${c.item_id}`);
    continue;
  }
  const dir = join(LIB, "captures", c.id);
  if (!existsSync(join(dir, "proc.jpg"))) {
    report.noFile++;
    console.warn(`capture ${c.id}: no proc.jpg`);
    continue;
  }
  const metaFile = join(dir, "meta.json");
  const meta = JSON.parse(existsSync(metaFile) ? readFileSync(metaFile, "utf8") : (c.meta ?? "{}")) as Record<
    string,
    unknown
  >;
  const widthMm = Number(meta.width_mm ?? c.width_mm) || undefined;
  const heightMm = Number(meta.height_mm ?? c.height_mm) || undefined;
  if (c.side === "top" && widthMm && heightMm) sizeOf.set(thingId, { w: widthMm, h: heightMm });
  if (DRY) continue;

  const f = await media.ingest(readFileSync(join(dir, "proc.jpg")), "proc.jpg");
  const rawPath = join(dir, "raw.jpg");
  const original = existsSync(rawPath) ? media.put(readFileSync(rawPath), "jpg") : null;
  if (original) report.originals++;
  const data: Record<string, unknown> = {
    rig: "pcb-photo-maker",
    view: c.side,
    captureId: c.id,
    pxPerMm: Number(meta.px_per_mm ?? 20),
    ...(widthMm ? { widthMm } : {}),
    ...(heightMm ? { heightMm } : {}),
    ...(meta.outline_w_mm ? { outlineWmm: meta.outline_w_mm, outlineHmm: meta.outline_h_mm } : {}),
    ...(meta.angle_deg !== undefined ? { angleDeg: meta.angle_deg } : {}),
    // Bottoms are mirrored to line up with the top; not yet auto-aligned by rotation.
    mirrored: c.side === "bottom",
    rotate90: c.rotate90,
    ...(c.camera_file ? { cameraFile: c.camera_file } : {}),
    ...(c.calib_id ? { calibId: c.calib_id } : {}),
    capturedAt: c.created_at,
  };
  const patch: AssetPatch = {
    file: f.file,
    mime: f.mime,
    bytes: f.bytes,
    width: f.width ?? null,
    height: f.height ?? null,
    thumb: f.thumb ?? null,
    original,
    key: `pcbphoto:${c.id}`,
    data,
  };

  const existing = store.assetByKey(thingId, `pcbphoto:${c.id}`);
  if (existing) {
    const before = JSON.stringify(existing);
    const after = JSON.stringify(store.changeAsset(existing.id, patch, ACTOR));
    report[before === after ? "unchanged" : "updated"]++;
    continue;
  }
  // The top photo HomeBox gave us is this same picture: upgrade it in place (it stays the cover).
  const fromHomebox =
    c.side === "top"
      ? store.assets(thingId).find((a) => a.role === "photo" && a.source === "homebox" && !a.key)
      : undefined;
  if (fromHomebox) {
    store.changeAsset(fromHomebox.id, patch, ACTOR);
    report.upgraded++;
  } else {
    store.addAsset(
      thingId,
      {
        role: "photo",
        file: f.file,
        mime: f.mime,
        bytes: f.bytes,
        ...(f.width ? { width: f.width } : {}),
        ...(f.height ? { height: f.height } : {}),
        ...(f.thumb ? { thumb: f.thumb } : {}),
        ...(original ? { original } : {}),
        key: `pcbphoto:${c.id}`,
        source: "import",
        data,
      },
      ACTOR,
    );
    report.added++;
  }
}

// --- 3. HomeBox PCB entities → kind pcb with proper fields
const kinds = { converted: 0, already: 0 };
for (const ref of store.refsByService("homebox")) {
  if (ref.data.entityType !== "PCB") continue;
  const t = store.getRaw(ref.thingId);
  if (!t) continue;
  const d = t.data;
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  const size = sizeOf.get(t.id);
  const next: Record<string, unknown> = {
    slug: d.slug ?? d.hb_slug,
    revision: d.revision ?? d.hb_revision,
    width_mm: num(d.width_mm) ?? size?.w ?? num(d.hb_width_mm),
    height_mm: num(d.height_mm) ?? size?.h ?? num(d.hb_height_mm),
    hb_slug: null,
    hb_revision: null,
    hb_width_mm: null,
    hb_height_mm: null,
  };
  const needs = t.kind !== "pcb" || Object.keys(d).some((k) => k.startsWith("hb_"));
  if (!needs) {
    kinds.already++;
    continue;
  }
  if (!DRY) store.change(t.id, { kind: "pcb", data: next }, "import", ACTOR);
  kinds.converted++;
}

console.log(DRY ? "dry run:" : "done:", { ...report, kinds });
