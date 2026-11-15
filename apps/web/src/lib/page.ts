// Product pages (link-preview.ts on the server): helpers shared by the Add screen and
// "Add product link" on an existing thing (D-023).
import type { Preview } from "./api.ts";

export function isUrl(s: string) {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

export function parsePrice(p: string | undefined): { price?: number; currency?: string } {
  const m = p?.match(/([\d.,]+)\s*([A-Z]{3})?/);
  if (!m?.[1]) return {};
  const n = Number(m[1].replace(/,(?=\d{2}$)/, ".").replace(/,/g, ""));
  return Number.isFinite(n) ? { price: n, ...(m[2] ? { currency: m[2] } : {}) } : {};
}

/** What a page can fill in, as thing data (all with source "page"). */
export function pageData(page: Preview): Record<string, string | number> {
  return {
    ...(page.title ? { productName: page.title } : {}),
    ...(page.brand ? { maker: page.brand } : {}),
    ...parsePrice(page.price),
  };
}

/** Input for the suggest-thing AI task: the name plus a short page summary. */
export function aiInput(name: string, url: string | null, page: Preview | null): Record<string, unknown> {
  return {
    name,
    ...(url ? { url } : {}),
    ...(page
      ? {
          page: {
            ...(page.title ? { title: page.title } : {}),
            ...(page.description ? { description: page.description.slice(0, 600) } : {}),
            ...(page.siteName ? { siteName: page.siteName } : {}),
            ...(page.price ? { price: page.price } : {}),
            ...(page.brand ? { brand: page.brand } : {}),
          },
        }
      : {}),
  };
}
