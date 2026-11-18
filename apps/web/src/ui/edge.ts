import type { CSSProperties, SyntheticEvent } from "react";

/**
 * Photos are drawn whole (object-fit: contain). The gaps around a non-square one take the colour
 * of the photo's own edges facing them: a PCB shot on white paper gets white bars. Busy edges
 * (no single colour to continue) keep the plain background. Sampled once per picture in the
 * browser; the pictures come from our own origin, so the canvas can be read.
 */
const cache = new Map<string, string | null>();

const S = 48; // sampling size: plenty for an edge colour, cheap to read
const STRIP = 2; // edge strip thickness in sampled pixels
const BUSY = 48; // widest per-channel spread (inter-quartile) still counted as one colour

function sample(img: HTMLImageElement): string | null {
  const { naturalWidth: nw, naturalHeight: nh, clientWidth: bw, clientHeight: bh } = img;
  if (!nw || !nh || !bw || !bh) return null;
  // Which edges face the gaps: left/right when the photo is narrower than its box.
  const sides = nw / nh < bw / bh;
  const w = sides ? Math.max(STRIP * 2, Math.round((S * nw) / nh)) : S;
  const h = sides ? S : Math.max(STRIP * 2, Math.round((S * nh) / nw));
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.canvas.width = w;
  ctx.canvas.height = h;
  ctx.drawImage(img, 0, 0, w, h);
  const strips = sides
    ? [ctx.getImageData(0, 0, STRIP, h), ctx.getImageData(w - STRIP, 0, STRIP, h)]
    : [ctx.getImageData(0, 0, w, STRIP), ctx.getImageData(0, h - STRIP, w, STRIP)];
  const ch: number[][] = [[], [], []];
  for (const { data } of strips)
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! < 250) return null; // transparent edge: nothing to continue
      for (let c = 0; c < 3; c++) ch[c]!.push(data[i + c]!);
    }
  const rgb: number[] = [];
  for (const xs of ch) {
    xs.sort((a, b) => a - b);
    const q = (p: number) => xs[Math.floor(p * (xs.length - 1))]!;
    if (q(0.75) - q(0.25) > BUSY) return null;
    rgb.push(q(0.5));
  }
  return `rgb(${rgb.join(" ")})`;
}

/** Props for a photo `<img>`: the edge colour behind it once known (instantly when cached). */
export function edgeFill(src: string): {
  style: CSSProperties | undefined;
  onLoad: (e: SyntheticEvent<HTMLImageElement>) => void;
} {
  const known = cache.get(src);
  return {
    style: known ? { backgroundColor: known } : undefined,
    onLoad: (e) => {
      const img = e.currentTarget;
      if (!cache.has(src)) {
        try {
          cache.set(src, sample(img));
        } catch {
          cache.set(src, null); // unreadable (cross-origin): keep the plain background
        }
      }
      img.style.backgroundColor = cache.get(src) ?? "";
    },
  };
}
