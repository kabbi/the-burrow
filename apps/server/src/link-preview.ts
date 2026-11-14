// Free, deterministic product-page reading: OpenGraph + JSON-LD Product.
// No AI involved. Used by the Add screen when someone pastes a link.

export interface PagePreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  price?: string;
  brand?: string;
}

const MAX_BYTES = 2_000_000;

export function looksLikeUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

export async function fetchPreview(rawUrl: string): Promise<PagePreview> {
  const url = new URL(rawUrl.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) links");
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en,fr;q=0.8,pl;q=0.6",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await readCapped(res, MAX_BYTES);
  return parsePreview(html, res.url || url.href);
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function parsePreview(html: string, url: string): PagePreview {
  const meta = (name: string) => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`,
      "i",
    );
    const m = re.exec(html);
    return decode(m?.[1] ?? m?.[2]);
  };
  const title = meta("og:title") ?? decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]);
  const p: PagePreview = { url };
  const set = <K extends keyof PagePreview>(k: K, v: PagePreview[K] | undefined) => {
    if (v) p[k] = v;
  };
  set("title", title);
  set("description", meta("og:description") ?? meta("description"));
  set("siteName", meta("og:site_name") ?? new URL(url).hostname.replace(/^www\./, ""));
  const img = meta("og:image");
  if (img) set("image", new URL(img, url).href);
  const amount = meta("product:price:amount") ?? meta("og:price:amount");
  const cur = meta("product:price:currency") ?? meta("og:price:currency");
  if (amount) set("price", `${amount}${cur ? ` ${cur}` : ""}`);

  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const product = findProduct(JSON.parse(m[1]!));
      if (!product) continue;
      if (!p.title && typeof product.name === "string") set("title", product.name);
      const brand = product.brand as { name?: string } | string | undefined;
      set("brand", typeof brand === "string" ? brand : brand?.name);
      const offer = (Array.isArray(product.offers) ? product.offers[0] : product.offers) as
        | { price?: unknown; priceCurrency?: string; lowPrice?: unknown }
        | undefined;
      const price = offer?.price ?? offer?.lowPrice;
      if (!p.price && price !== undefined)
        set("price", `${String(price)} ${offer?.priceCurrency ?? ""}`.trim());
      if (!p.image) {
        const im = Array.isArray(product.image) ? product.image[0] : product.image;
        if (typeof im === "string") set("image", new URL(im, url).href);
      }
      break;
    } catch {
      // broken JSON-LD is common; ignore
    }
  }
  return p;
}

function findProduct(j: unknown): Record<string, unknown> | null {
  if (Array.isArray(j)) {
    for (const x of j) {
      const f = findProduct(x);
      if (f) return f;
    }
    return null;
  }
  if (j && typeof j === "object") {
    const o = j as Record<string, unknown>;
    const t = o["@type"];
    if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) return o;
    if (o["@graph"]) return findProduct(o["@graph"]);
  }
  return null;
}

function decode(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const out = s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .trim();
  return out || undefined;
}
