// One-off, idempotent migration to assets (D-015): every thing's data.imageUrl /
// data.thumbUrl becomes an asset (HomeBox photos → "photo"; web images → "product",
// downloaded into the media dir), and the old fields are cleared. Every change is
// an event. Takes a VACUUM INTO backup first.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Store, type FieldSource } from "@burrow/core";
import { config } from "../config.ts";
import { aiMigrations } from "../ai/gateway.ts";
import { Media } from "../media.ts";

const ACTOR = "migration";
const store = Store.open(config.db, aiMigrations);
const media = new Media(config.mediaDir);

const backups = join(dirname(config.db), "backups");
mkdirSync(backups, { recursive: true });
const backup = join(backups, `burrow-${new Date().toISOString().replace(/[:.]/g, "-")}-before-0004.sqlite`);
store.db.exec(`vacuum into '${backup.replace(/'/g, "''")}'`);
console.log("backup:", backup);

const report = { things: 0, photos: 0, products: 0, failed: 0 };
const rows = store.db
  .prepare(
    "select id from things where json_extract(data, '$.imageUrl') is not null or json_extract(data, '$.thumbUrl') is not null",
  )
  .all() as { id: string }[];

for (const { id } of rows) {
  const t = store.getRaw(id)!;
  const url = (t.data.imageUrl ?? t.data.thumbUrl) as string;
  const was = t.meta.imageUrl?.source ?? t.meta.thumbUrl?.source ?? "import";
  try {
    let buf: Buffer;
    let source: FieldSource;
    let data: Record<string, unknown> = {};
    if (url.startsWith("/media/")) {
      const file = join(config.mediaDir, url.slice(7));
      if (!existsSync(file)) throw new Error(`missing file ${file}`);
      buf = readFileSync(file);
      source = was === "import" ? "homebox" : was;
    } else {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      source = "page";
      data = { url };
    }
    const f = await media.ingest(buf, url);
    const role = source === "page" ? "product" : "photo";
    if (!store.assets(id, { removed: true }).some((a) => a.file === f.file))
      store.addAsset(
        id,
        {
          role,
          file: f.file,
          mime: f.mime,
          bytes: f.bytes,
          ...(f.width ? { width: f.width } : {}),
          ...(f.height ? { height: f.height } : {}),
          ...(f.thumb ? { thumb: f.thumb } : {}),
          source,
          data,
        },
        ACTOR,
      );
    store.change(id, { data: { imageUrl: null, thumbUrl: null } }, "import", ACTOR);
    report.things++;
    report[role === "photo" ? "photos" : "products"]++;
  } catch (e) {
    report.failed++;
    console.warn(`${id} ${url}: ${(e as Error).message}`);
  }
}
console.log(report);
