import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import * as ort from "onnxruntime-web";
import type { Migration, Store } from "@burrow/core";

// "Have I got this already?" by looks (D-019). A small image model (DINOv2-small, good at
// telling one object from a similar one) turns each picture into a vector, on this machine's
// CPU: no GPU box, no cloud. Vectors are kept per media file (content-addressed), so a
// picture is only ever looked at once.

export const visionMigrations: Migration[] = [
  {
    id: "vision/001-image-vectors",
    sql: `create table image_vectors (
            file text not null,
            model text not null,
            vec blob not null,
            primary key (file, model)
          );`,
  },
];

const MODEL = {
  id: "dinov2-small-q8",
  // Pinned revision: the file can't change under us.
  url: "https://huggingface.co/onnx-community/dinov2-small/resolve/8b1f705a3a7f6f062f6bdd21986c1583d3ef105d/onnx/model_quantized.onnx",
  bytes: 24_446_700,
  size: 224,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
};

export interface VisualHit {
  thingId: string;
  /** Cosine similarity of the closest picture of that thing, 0..1. */
  score: number;
}

/** What the bot needs (a fake in tests). */
export interface VisualMatcher {
  similar(file: string, limit?: number, exclude?: Set<string>): Promise<VisualHit[]>;
  refresh(): Promise<number>;
}

export class ImageIndex implements VisualMatcher {
  private store: Store;
  private mediaDir: string;
  private modelDir: string;
  private session: Promise<ort.InferenceSession> | null = null;
  private cache = new Map<string, Float32Array>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: Store, mediaDir: string, modelDir: string) {
    this.store = store;
    this.mediaDir = mediaDir;
    this.modelDir = modelDir;
  }

  /** Vector for one picture (cached). "<file>#flop" = the picture mirrored back. */
  async vector(file: string): Promise<Float32Array> {
    const hit = this.cache.get(file) ?? this.fromDb(file);
    if (hit) return hit;
    const [name, flag] = file.split("#");
    const v = await this.serial(() => this.embed(join(this.mediaDir, name!), 0, flag === "flop"));
    this.store.db
      .prepare("insert or replace into image_vectors (file, model, vec) values (?, ?, ?)")
      .run(file, MODEL.id, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    this.cache.set(file, v);
    return v;
  }

  /** Index pictures that have no vector yet. Returns how many were added. */
  async refresh(): Promise<number> {
    let n = 0;
    for (const { file } of this.pictures()) {
      if (this.cache.has(file) || this.fromDb(file)) continue;
      try {
        await this.vector(file);
        n++;
      } catch (e) {
        console.warn(`vision: can't index ${file}: ${(e as Error).message}`);
        // Remember it as unreadable (zero vector) so it isn't retried on every photo.
        this.cache.set(file, new Float32Array(1));
      }
    }
    return n;
  }

  /** Things whose pictures look most like this one. */
  async similar(file: string, limit = 5, exclude: Set<string> = new Set()): Promise<VisualHit[]> {
    // The model isn't rotation-invariant and phone shots of flat things come any way up:
    // look at the new photo four ways and keep the best match.
    const qs = [await this.vector(file)];
    for (const deg of [90, 180, 270])
      qs.push(await this.serial(() => this.embed(join(this.mediaDir, file), deg)));
    await this.refresh();
    const best = new Map<string, number>();
    for (const p of this.pictures()) {
      if (exclude.has(p.thingId)) continue;
      const v = this.cache.get(p.file) ?? this.fromDb(p.file);
      if (!v || v.length !== qs[0]!.length) continue;
      const s = Math.max(...qs.map((q) => dot(q, v)));
      if (s > (best.get(p.thingId) ?? -1)) best.set(p.thingId, s);
    }
    return [...best]
      .map(([thingId, score]) => ({ thingId, score }))
      .toSorted((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Our own photos and shop pictures of live things (icons and models don't say what it looks like). */
  private pictures(): { thingId: string; file: string }[] {
    // The PCB rig stores bottoms mirrored (to line up with the top): index them as a camera sees them.
    return this.store.db
      .prepare(
        `select a.thing_id thingId,
             coalesce(a.thumb, a.file) || case when json_extract(a.data, '$.mirrored') then '#flop' else '' end file
           from assets a
           join things t on t.id = a.thing_id
           where a.removed_at is null and t.archived_at is null and a.role in ('photo', 'product')
             and a.mime like 'image/%' and a.mime != 'image/svg+xml'`,
      )
      .all() as { thingId: string; file: string }[];
  }

  private fromDb(file: string): Float32Array | null {
    const r = this.store.db
      .prepare("select vec from image_vectors where file = ? and model = ?")
      .get(file, MODEL.id) as { vec: Uint8Array } | undefined;
    if (!r) return null;
    const v = new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength));
    this.cache.set(file, v);
    return v;
  }

  /** One picture at a time: the model is CPU-heavy. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private async embed(path: string, turn = 0, flop = false): Promise<Float32Array> {
    const session = await this.load();
    const S = MODEL.size;
    // The whole object matters more than the model's usual centre crop: fit it on white.
    const upright = await sharp(path, { animated: false }).rotate().flop(flop).toBuffer();
    const { data } = await sharp(upright)
      .rotate(turn)
      .resize(S, S, { fit: "contain", background: "#ffffff", kernel: "cubic" })
      .flatten({ background: "#ffffff" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = new Float32Array(3 * S * S);
    for (let i = 0; i < S * S; i++)
      for (let c = 0; c < 3; c++)
        px[c * S * S + i] = (data[i * 3 + c]! / 255 - MODEL.mean[c]!) / MODEL.std[c]!;
    const out = await session.run({ pixel_values: new ort.Tensor("float32", px, [1, 3, S, S]) });
    // The CLS token (first row of last_hidden_state, already layer-normed) is DINOv2's image vector.
    const h = out.last_hidden_state!;
    const dim = h.dims[2]!;
    return normalize(Float32Array.from((h.data as Float32Array).subarray(0, dim)));
  }

  private load(): Promise<ort.InferenceSession> {
    this.session ??= (async () => {
      const file = join(this.modelDir, `${MODEL.id}.onnx`);
      if (!existsSync(file) || statSync(file).size !== MODEL.bytes) {
        mkdirSync(this.modelDir, { recursive: true });
        console.log(`vision: downloading ${MODEL.id} (${(MODEL.bytes / 1e6).toFixed(0)} MB, once)`);
        const r = await fetch(MODEL.url, { signal: AbortSignal.timeout(300_000) });
        if (!r.ok) throw new Error(`model download HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length !== MODEL.bytes) throw new Error(`model download: got ${buf.length} bytes`);
        writeFileSync(`${file}.part`, buf);
        renameSync(`${file}.part`, file);
      }
      ort.env.wasm.numThreads = 2;
      return ort.InferenceSession.create(file, { executionProviders: ["wasm"] });
    })();
    this.session.catch(() => (this.session = null));
    return this.session;
  }
}

function normalize(v: Float32Array) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

function dot(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
