import { BurrowError } from "@burrow/core";
import { UpstreamError } from "./http.ts";

/**
 * Stable Fast 3D (~/dev/tools/stable-fast-3d/server.py on fedora): POST an image,
 * get a textured GLB. Local and free, but it is a shared GPU: one request at a
 * time from Burrow (the server also serializes on its side).
 */
export class Sf3d {
  readonly url: string;
  private busy = false;
  constructor(url: string) {
    this.url = url;
  }
  get configured() {
    return Boolean(this.url);
  }

  async health(): Promise<{ ok: boolean; device?: string; busy: boolean }> {
    if (!this.url) return { ok: false, busy: false };
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(3000) });
      const j = (await res.json()) as { status?: string; device?: string };
      return { ok: res.ok && j.status === "ok", ...(j.device ? { device: j.device } : {}), busy: this.busy };
    } catch {
      return { ok: false, busy: this.busy };
    }
  }

  async generate(
    image: Buffer,
    mime: string,
    opts: { removeBg?: boolean; textureResolution?: number } = {},
  ): Promise<{ glb: Buffer; seconds: number }> {
    if (!this.url) throw new BurrowError("3D generation isn't set up (SF3D_URL)", 503);
    if (this.busy) throw new BurrowError("Already making a 3D model; try again when it's done", 409);
    this.busy = true;
    try {
      const form = new FormData();
      form.append("image", new Blob([new Uint8Array(image)], { type: mime }), "image");
      const q = new URLSearchParams({
        remove_bg: String(opts.removeBg ?? true),
        texture_resolution: String(opts.textureResolution ?? 1024),
        remesh: "none",
      });
      let res: Response;
      try {
        res = await fetch(`${this.url}/generate?${q}`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(5 * 60_000),
        });
      } catch (e) {
        throw new UpstreamError("stable-fast-3d", 502, `unreachable (${(e as Error).message})`);
      }
      if (!res.ok)
        throw new UpstreamError(
          "stable-fast-3d",
          res.status,
          `HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`,
        );
      const glb = Buffer.from(await res.arrayBuffer());
      return { glb, seconds: Number(res.headers.get("x-generation-time") ?? 0) };
    } finally {
      this.busy = false;
    }
  }
}
