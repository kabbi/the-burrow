import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp, { type Metadata } from "sharp";
import { BurrowError } from "@burrow/core";

// Files Burrow owns live in one flat, content-addressed directory (D-015):
// "<first 32 hex of sha256>.<ext>". The same bytes are stored once, files are
// never overwritten, and removing an asset leaves its file (so undo works).

export interface Ingested {
  file: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  /** A smaller preview file, when the original is big. */
  thumb?: string;
  kind: "image" | "model";
}

const IMAGE_TYPES: Record<string, { mime: string; ext: string }> = {
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  png: { mime: "image/png", ext: "png" },
  webp: { mime: "image/webp", ext: "webp" },
  gif: { mime: "image/gif", ext: "gif" },
  avif: { mime: "image/avif", ext: "avif" },
  heif: { mime: "image/avif", ext: "avif" },
  svg: { mime: "image/svg+xml", ext: "svg" },
};

export const MODEL_EXTS = ["glb", "stl"] as const;
const THUMB_PX = 480;

export class Media {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  /** Store bytes under their hash; returns the file name. */
  put(buf: Buffer, ext: string): string {
    const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 32)}.${ext}`;
    const path = join(this.dir, name);
    if (!existsSync(path)) writeFileSync(path, buf);
    return name;
  }

  path(file: string): string {
    if (!/^[\w.-]+$/.test(file)) throw new BurrowError("Bad file name");
    return join(this.dir, file);
  }

  /** Sniff, store and (for big images) make a thumbnail. Throws on files Burrow can't show. */
  async ingest(buf: Buffer, filename = ""): Promise<Ingested> {
    if (!buf.length) throw new BurrowError("Empty file");
    const model = sniffModel(buf, filename);
    if (model) return { file: this.put(buf, model.ext), mime: model.mime, bytes: buf.length, kind: "model" };

    let meta: Metadata;
    try {
      meta = await sharp(buf).metadata();
    } catch {
      throw new BurrowError(
        "Not a picture or 3D model Burrow understands (jpg, png, webp, gif, svg, glb, stl)",
      );
    }
    const type = IMAGE_TYPES[meta.format ?? ""];
    if (!type) throw new BurrowError(`Unsupported picture format "${meta.format}"`);
    const file = this.put(buf, type.ext);
    // EXIF orientations 5–8 are rotated by 90°: report the size as it is shown.
    const turned = (meta.orientation ?? 1) >= 5;
    const width = turned ? meta.height : meta.width;
    const height = turned ? meta.width : meta.height;
    const out: Ingested = { file, mime: type.mime, bytes: buf.length, kind: "image" };
    if (width) out.width = width;
    if (height) out.height = height;
    const big = Math.max(width ?? 0, height ?? 0) > THUMB_PX * 1.5 || buf.length > 300_000;
    if (type.ext !== "svg" && big) out.thumb = await this.thumbnail(buf);
    return out;
  }

  /** A small webp preview (rotated upright). Also used for 3D model posters. */
  async thumbnail(buf: Buffer): Promise<string> {
    const small = await sharp(buf, { animated: false })
      .rotate()
      .resize(THUMB_PX, THUMB_PX, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    return this.put(small, "webp");
  }
}

function sniffModel(buf: Buffer, filename: string): { mime: string; ext: string } | null {
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "glTF")
    return { mime: "model/gltf-binary", ext: "glb" };
  const ext = filename.toLowerCase().split(".").pop();
  const binaryStl = buf.length >= 84 && 84 + buf.readUInt32LE(80) * 50 === buf.length;
  const asciiStl = /^\s*solid[\s\S]*facet/.test(buf.toString("ascii", 0, Math.min(buf.length, 2048)));
  if ((binaryStl && ext === "stl") || asciiStl) return { mime: "model/stl", ext: "stl" };
  return null;
}
