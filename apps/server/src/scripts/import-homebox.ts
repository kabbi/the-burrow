// One-time import from HomeBox (D-010: Burrow is now the system of record).
// Idempotent and read-only towards HomeBox:
//  1. items + locations → things (skips ones already linked)
//  2. HomeBox tag nesting → tag things nested the same way
//  3. photos + thumbnails → data/media (content-addressed), imageUrl → /media/<file>
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "@burrow/core";
import { config } from "../config.ts";
import { aiMigrations } from "../ai/gateway.ts";
import { HomeBox, syncFromHomeBox, type HbTag } from "../adapters/homebox.ts";

const ACTOR = "homebox-import";
const store = Store.open(config.db, aiMigrations);
const hb = new HomeBox(config.homebox.url, config.homebox.token);
mkdirSync(config.mediaDir, { recursive: true });

const sync = await syncFromHomeBox(store, hb);
console.log("things:", { created: sync.created, unchanged: sync.unchanged, errors: sync.errors.length });

// --- tag nesting
const hbTags = await hb.tags();
const byId = new Map(hbTags.map((t) => [t.id, t]));
let nested = 0;
for (const t of hbTags) {
  const parent = t.parentId ? byId.get(t.parentId) : undefined;
  if (!parent) continue;
  const tagId = store.findTag(t.name);
  if (!tagId) continue; // tag not used by any imported thing
  const parentTag = store.ensureTag(parent.name, ACTOR, ensureParentChain(parent));
  if (store.getRaw(tagId)?.parentId !== parentTag && tagId !== parentTag) {
    store.move(tagId, parentTag, ACTOR, "homebox");
    nested++;
  }
}
function ensureParentChain(t: HbTag): string | null {
  const p = t.parentId ? byId.get(t.parentId) : undefined;
  return p ? store.ensureTag(p.name, ACTOR, ensureParentChain(p)) : null;
}
console.log("tags nested:", nested);

// --- media
const ext = (type: string | null) =>
  ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" })[type ?? ""] ??
  "bin";
let copied = 0;
let failed = 0;
for (const ref of store.refsByService("homebox")) {
  const t = store.getRaw(ref.thingId);
  if (!t) continue;
  const patch: Record<string, string> = {};
  for (const key of ["imageUrl", "thumbUrl"] as const) {
    const url = t.data[key];
    const m = typeof url === "string" ? /^\/api\/homebox\/image\/([^/]+)\/([^/]+)$/.exec(url) : null;
    if (!m) continue;
    try {
      const res = await hb.attachment(m[1]!, m[2]!);
      const buf = Buffer.from(await res.arrayBuffer());
      const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 32)}.${ext(res.headers.get("content-type"))}`;
      const file = join(config.mediaDir, name);
      if (!existsSync(file)) writeFileSync(file, buf);
      patch[key] = `/media/${name}`;
      copied++;
    } catch (e) {
      failed++;
      console.warn(`${t.id} ${key}: ${(e as Error).message}`);
    }
  }
  if (Object.keys(patch).length) store.change(t.id, { data: patch }, "import", ACTOR);
}
console.log("media:", { copied, failed, dir: config.mediaDir });
