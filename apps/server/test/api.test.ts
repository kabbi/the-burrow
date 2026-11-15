import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { z } from "zod";
import { Store } from "@burrow/core";
import { createApp, createDeps } from "../src/app.ts";
import { config } from "../src/config.ts";
import { AiGateway, aiMigrations } from "../src/ai/gateway.ts";
import type { Prompt, Provider } from "../src/ai/providers.ts";
import { suggestThingTask } from "../src/ai/tasks.ts";
import { PaperlessMock } from "../src/adapters/paperless-mock.ts";
import { parsePreview } from "../src/link-preview.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Sf3d } from "../src/adapters/sf3d.ts";

/** Pretends to be Stable Fast 3D: returns a tiny valid-looking GLB. */
class FakeSf3d extends Sf3d {
  calls = 0;
  constructor() {
    super("http://sf3d.test");
  }
  override async health() {
    return { ok: true, device: "fake", busy: false };
  }
  override async generate() {
    this.calls++;
    const glb = Buffer.alloc(20);
    glb.write("glTF", 0, "ascii");
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(20, 8);
    return { glb, seconds: 1.5 };
  }
}
const fakeSf3d = new FakeSf3d();

class FakeAnthropic implements Provider {
  readonly id = "anthropic" as const;
  readonly configured = true;
  calls = 0;
  async countTokens(p: Prompt, _m: string, _s: z.ZodType) {
    return { tokens: Math.ceil((p.system.length + p.user.length) / 4), exact: true };
  }
  async complete<O>(_p: Prompt, model: string, schema: z.ZodType<O>) {
    this.calls++;
    const output = schema.parse({
      name: "Moka pot, 6-cup",
      kind: "thing",
      description: "Stovetop coffee maker.",
      tags: ["coffee", "kitchen"],
      maker: "Bialetti",
      model: null,
      quantity: null,
      placeId: "B-0001",
      question: null,
    });
    return { output, model, inputTokens: 900, outputTokens: 300 };
  }
}

let server: Server;
let base = "";
const fake = new FakeAnthropic();

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as T & { error?: string } };
}

beforeAll(async () => {
  const store = Store.open(":memory:", aiMigrations);
  const ai = new AiGateway(store.db, [fake]);
  ai.register(suggestThingTask(store));
  // Never write test files into the real media dir.
  const mediaDir = mkdtempSync(join(tmpdir(), "burrow-media-"));
  const deps = createDeps(
    { ...config, mediaDir },
    { store, ai, paperless: new PaperlessMock(), inboxTagNames: ["inbox"], sf3d: fakeSf3d },
  );
  server = createApp(deps).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => server.close());

describe("things API", () => {
  it("creates, finds, moves and undoes", async () => {
    const kitchen = await call<{ thing: { id: string } }>("POST", "/things", {
      name: "Kitchen",
      kind: "room",
    });
    expect(kitchen.status).toBe(201);
    expect(kitchen.body.thing.id).toBe("B-0001");
    const moka = await call<{ thing: { id: string; gaps: string[] } }>("POST", "/things", {
      name: "moka pot",
    });
    expect(moka.body.thing.gaps).toEqual(["where"]);

    const s = await call<{ hits: { thing: { id: string } }[] }>("GET", "/search?q=mok");
    expect(s.body.hits.map((h) => h.thing.id)).toEqual(["B-0002"]);

    const mv = await call<{ event: { seq: number }; thing: { path: { name: string }[] } }>(
      "POST",
      "/things/B-0002/move",
      { to: "B-0001" },
    );
    expect(mv.body.thing.path.map((p) => p.name)).toEqual(["Kitchen"]);
    await call("POST", `/events/${mv.body.event.seq}/undo`);
    const after = await call<{ thing: { parentId: string | null } }>("GET", "/things/B-0002");
    expect(after.body.thing.parentId).toBeNull();

    const bad = await call("POST", "/things/B-0001/move", { to: "B-0001" });
    expect(bad.status).toBe(400);
    expect((await call("GET", "/things/B-0999")).status).toBe(404);
    expect((await call("POST", "/things", { name: "" })).status).toBe(400);
  });
});

describe("AI gateway", () => {
  it("quotes first, runs once, applies accepted-by-default", async () => {
    const before = fake.calls;
    const q = await call<{ quote: { id: string; estCostUsd: number; maxCostUsd: number } }>(
      "POST",
      "/ai/quote",
      {
        task: "suggest-thing",
        input: { name: "moka pot" },
        provider: "anthropic",
        model: "claude-opus-5-5",
      },
    );
    expect(q.status).toBe(200);
    expect(fake.calls).toBe(before); // quoting never calls the model
    expect(q.body.quote.estCostUsd).toBeGreaterThan(0);
    expect(q.body.quote.maxCostUsd).toBeGreaterThan(q.body.quote.estCostUsd);

    const run = await call<{ request: { status: string; actualCostUsd: number } }>(
      "POST",
      `/ai/requests/${q.body.quote.id}/run`,
    );
    expect(run.body.request.status).toBe("done");
    expect(run.body.request.actualCostUsd).toBeCloseTo((900 * 4 + 300 * 20) / 1e6);
    expect((await call("POST", `/ai/requests/${q.body.quote.id}/run`)).status).toBe(409);
    expect(fake.calls).toBe(before + 1);

    const applied = await call<{
      thing: {
        name: string;
        parentId: string;
        data: Record<string, unknown>;
        tags: { name: string; source?: string }[];
      };
    }>("POST", "/things/B-0002/apply-suggestion", { requestId: q.body.quote.id, reject: ["maker"] });
    expect(applied.body.thing.name).toBe("Moka pot, 6-cup");
    expect(applied.body.thing.data.maker).toBeUndefined();
    expect(applied.body.thing.tags.map((t) => [t.name, t.source])).toEqual([
      ["coffee", "ai"],
      ["kitchen", "ai"],
    ]);
    expect(applied.body.thing.parentId).toBe("B-0001");
  });

  it("refuses unknown providers and models", async () => {
    const r = await call("POST", "/ai/quote", {
      task: "suggest-thing",
      input: { name: "x" },
      provider: "ollama",
    });
    expect(r.status).toBe(503);
    const m = await call("POST", "/ai/quote", {
      task: "suggest-thing",
      input: { name: "x" },
      provider: "anthropic",
      model: "claude-unknown",
    });
    expect(m.status).toBe(400);
  });
});

describe("papers API (mock paperless)", () => {
  it("lists the inbox and files a paper onto a thing", async () => {
    const inbox = await call<{ count: number; docs: { id: number; why: string }[] }>("GET", "/papers/inbox");
    expect(inbox.body.count).toBe(6);
    const d = await call<{ suggestions: { correspondents: number[] }; guesses: unknown[] }>(
      "GET",
      "/papers/docs/101",
    );
    expect(d.body.suggestions.correspondents).toEqual([1]);

    const filed = await call<{
      doc: { tags: number[]; things: { id: string }[]; correspondentName: string };
    }>("POST", "/papers/docs/101/file", {
      correspondent: 1,
      document_type: 1,
      tags: [1, 2, 3],
      thingIds: ["B-0002"],
    });
    expect(filed.body.doc.tags).toEqual([2, 3]); // inbox tag removed
    expect(filed.body.doc.correspondentName).toBe("Example Furniture Co.");
    expect(filed.body.doc.things.map((t) => t.id)).toEqual(["B-0002"]);
    expect((await call<{ count: number }>("GET", "/papers/inbox")).body.count).toBe(5);

    const thing = await call<{ relations: { type: string; paperlessId: string; other: { kind: string } }[] }>(
      "GET",
      "/things/B-0002",
    );
    const doc = thing.body.relations.find((r) => r.type === "has_document")!;
    expect(doc.paperlessId).toBe("101");
    expect(doc.other.kind).toBe("document");

    // physical copy goes into a binder (a place); the document thing moves there
    const binder = await call<{ thing: { id: string } }>("POST", "/things", {
      name: "Binder A",
      kind: "container",
    });
    const placed = await call<{ entity: { parentId: string; data: { physicalCopy: boolean } } }>(
      "POST",
      "/papers/docs/101/place",
      { placeId: binder.body.thing.id },
    );
    expect(placed.body.entity.parentId).toBe(binder.body.thing.id);
    expect(placed.body.entity.data.physicalCopy).toBe(true);
  });
});

describe("link preview", () => {
  it("reads OpenGraph and JSON-LD products", () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="LAGAN Dishwasher &amp; more">
      <meta property="og:image" content="/img/lagan.jpg">
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"LAGAN","brand":{"@type":"Brand","name":"IKEA"},"offers":{"price":"299.00","priceCurrency":"EUR"}}</script>
      </head></html>`;
    const p = parsePreview(html, "https://www.ikea.com/fr/p/lagan");
    expect(p).toMatchObject({
      title: "LAGAN Dishwasher & more",
      image: "https://www.ikea.com/img/lagan.jpg",
      brand: "IKEA",
      price: "299.00 EUR",
      siteName: "ikea.com",
    });
  });
});

describe("extractJson", async () => {
  const { extractJson } = await import("../src/ai/providers.ts");
  it("finds JSON in prose and fences", () => {
    expect(JSON.parse(extractJson('\n\n{"a":1}'))).toEqual({ a: 1 });
    expect(JSON.parse(extractJson('Sure!\n```json\n{"a":{"b":[1]}}\n```\nDone'))).toEqual({ a: { b: [1] } });
    expect(() => extractJson("no json here")).toThrow(/no JSON/);
  });
});

describe("db browser API", () => {
  it("lists tables with roles and counts", async () => {
    const r = await call<{ tables: { name: string; role: string; rows: number }[] }>("GET", "/db/tables");
    const byName = Object.fromEntries(r.body.tables.map((t) => [t.name, t]));
    expect(byName.events?.role).toBe("log");
    expect(byName.things?.role).toBe("projection");
    expect(byName.things?.rows).toBeGreaterThan(0);
    expect(r.body.tables.some((t) => t.name.startsWith("things_fts_"))).toBe(false);
  });

  it("pages, searches and edits rows; rebuild restores projections", async () => {
    const page = await call<{ rows: { __rowid: number; id: string; name: string }[]; total: number }>(
      "GET",
      "/db/tables/things?search=B-0001",
    );
    expect(page.body.total).toBe(2); // the room itself + the moka pot whose parent_id is B-0001
    const row = page.body.rows.find((r) => r.id === "B-0001")!;
    const upd = await call<{ changes: number }>("PATCH", `/db/tables/things/rows/${row.__rowid}`, {
      name: "Kitchen (edited in db)",
      nope: 1,
    });
    expect(upd.body.changes).toBe(1);
    expect((await call<{ thing: { name: string } }>("GET", `/things/${row.id}`)).body.thing.name).toBe(
      "Kitchen (edited in db)",
    );
    await call("POST", "/db/rebuild");
    expect((await call<{ thing: { name: string } }>("GET", `/things/${row.id}`)).body.thing.name).toBe(
      "Kitchen",
    );
  });

  it("guards writes in the SQL console and rejects unknown tables", async () => {
    const read = await call<{ columns: string[]; rows: unknown[] }>("POST", "/db/query", {
      sql: "select id, name from things order by seq limit 2",
    });
    expect(read.body.columns).toEqual(["id", "name"]);
    expect((await call("POST", "/db/query", { sql: "delete from kv" })).status).toBe(400);
    expect((await call("POST", "/db/query", { sql: "selec nonsense" })).status).toBe(400);
    expect((await call("GET", '/db/tables/things"; drop table things; --')).status).toBe(404);
    const w = await call<{ changes: number }>("POST", "/db/query", {
      sql: "insert into kv (key, value) values ('test', '1')",
      write: true,
    });
    expect(w.body.changes).toBe(1);
  });
});

describe("schema, tags and relations API", () => {
  it("defines a kind with typed fields and validates values", async () => {
    const k = await call("POST", "/kinds", {
      id: "plant",
      name: "Plant",
      parent: "thing",
      fields: [{ key: "water", label: "Watering", type: "select", options: ["weekly", "monthly"] }],
    });
    expect(k.status).toBe(201);
    const p = await call<{ thing: { id: string } }>("POST", "/things", { name: "Monstera", kind: "plant" });
    expect((await call("PATCH", `/things/${p.body.thing.id}`, { data: { water: "daily" } })).status).toBe(
      400,
    );
    expect((await call("PATCH", `/things/${p.body.thing.id}`, { data: { water: "weekly" } })).status).toBe(
      200,
    );
    const schema = await call<{ kinds: { id: string; effectiveFields: { key: string }[] }[] }>(
      "GET",
      "/schema",
    );
    const plant = schema.body.kinds.find((x) => x.id === "plant")!;
    expect(plant.effectiveFields.map((f) => f.key)).toContain("description");
  });

  it("sets tags by name and links things with typed relations", async () => {
    const a = await call<{ thing: { id: string } }>("POST", "/things", {
      name: "Pixel 9",
      kind: "electronics",
    });
    const b = await call<{ thing: { id: string } }>("POST", "/things", { name: "Pixel 9 case" });
    const t = await call<{ thing: { tags: { name: string }[] } }>("PUT", `/things/${a.body.thing.id}/tags`, {
      names: ["phone", "Phone", "android"],
    });
    expect(t.body.thing.tags.map((x) => x.name)).toEqual(["android", "phone"]); // deduped case-insensitively
    const tags = await call<{ tags: { name: string; uses: number }[] }>("GET", "/tags");
    expect(tags.body.tags.find((x) => x.name === "phone")?.uses).toBe(1);

    const rel = await call<{ relations: { type: string; label: string; direction: string }[] }>(
      "POST",
      `/things/${a.body.thing.id}/relations`,
      { type: "accessory_of", otherId: b.body.thing.id, direction: "in" },
    );
    expect(rel.status).toBe(201);
    const notTags = (rs: { type: string }[]) => rs.filter((r) => r.type !== "tagged");
    expect(notTags(rel.body.relations)).toMatchObject([{ label: "accessories", direction: "in" }]);
    const bad = await call("POST", `/things/${a.body.thing.id}/relations`, {
      type: "tagged",
      otherId: b.body.thing.id,
    });
    expect(bad.status).toBe(400);
    const gone = await call<{ relations: { type: string }[] }>(
      "DELETE",
      `/things/${a.body.thing.id}/relations`,
      {
        type: "accessory_of",
        otherId: b.body.thing.id,
        direction: "in",
      },
    );
    expect(notTags(gone.body.relations)).toEqual([]);
  });
});

describe("assets", () => {
  const upload = async (id: string, body: Buffer, query: string) => {
    const res = await fetch(`${base}/things/${id}/assets?${query}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const png = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: "#c84" } })
      .png()
      .toBuffer();

  it("uploads photos, icons and models, picks covers, undoes", async () => {
    const t = (await call<{ thing: { id: string } }>("POST", "/things", { name: "Drill" })).body.thing;
    const big = await upload(t.id, await png(1600, 1200), "role=photo&filename=drill.png");
    expect(big.status).toBe(201);
    expect(big.body.asset).toMatchObject({ role: "photo", mime: "image/png", width: 1600, height: 1200 });
    expect(big.body.asset.thumb).toMatch(/\.webp$/);
    expect(big.body.cover.id).toBe(big.body.asset.id);

    // The file is served from /media with a strict CSP.
    const file = await fetch(base.replace("/api", "") + big.body.asset.fileUrl);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-security-policy")).toContain("default-src 'none'");

    // Icons: search the bundled sets, attach one as an SVG.
    const icons = await call<{ icons: { set: string; name: string }[] }>("GET", "/icons?q=hammer");
    expect(icons.body.icons.length).toBeGreaterThan(0);
    const ic = icons.body.icons[0]!;
    const svg = await fetch(`${base}/icons/${ic.set}/${ic.name}.svg`);
    expect(await svg.text()).toMatch(/^<svg/);
    const icon = await call<Record<string, any>>("POST", `/things/${t.id}/assets/icon`, ic);
    expect(icon.body.asset).toMatchObject({ role: "icon", mime: "image/svg+xml", source: "icons" });
    expect(icon.body.asset.data.license).toBeTruthy();

    // An STL, even if called a photo, becomes a model; no cover until it has a poster.
    const stl = Buffer.alloc(84 + 50);
    stl.writeUInt32LE(1, 80);
    const model = await upload(t.id, stl, "role=photo&filename=bracket.stl");
    expect(model.body.asset).toMatchObject({ role: "model", mime: "model/stl", imageUrl: null });
    const poster = await fetch(`${base}/assets/${model.body.asset.id}/thumb`, {
      method: "POST",
      body: new Uint8Array(await png(800, 800)),
    });
    const after = (await poster.json()) as Record<string, any>;
    expect(after.asset.imageUrl).toMatch(/\.webp$/);

    // Choose the icon as the cover; undo goes back to automatic (the photo).
    const cov = await call<Record<string, any>>("POST", `/things/${t.id}/cover`, {
      assetId: icon.body.asset.id,
    });
    expect(cov.body.cover.id).toBe(icon.body.asset.id);
    const thing = await call<Record<string, any>>("GET", `/things/${t.id}`);
    expect(thing.body.thing.cover.id).toBe(icon.body.asset.id);
    expect(thing.body.assets).toHaveLength(3);
    await call("POST", `/events/${cov.body.event.seq}/undo`);
    expect((await call<Record<string, any>>("GET", `/things/${t.id}`)).body.thing.cover.id).toBe(
      big.body.asset.id,
    );

    // Remove, rename/re-role, reject junk.
    const rm = await call<Record<string, any>>("DELETE", `/assets/${big.body.asset.id}`);
    expect(rm.body.assets).toHaveLength(2);
    const ch = await call<Record<string, any>>("PATCH", `/assets/${icon.body.asset.id}`, {
      role: "sprite",
      label: "inventory",
    });
    expect(ch.body.asset).toMatchObject({ role: "sprite", label: "inventory" });
    expect((await upload(t.id, Buffer.from("hello"), "filename=x.txt")).status).toBe(400);
  });

  it("makes a 3D model from a photo with Stable Fast 3D", async () => {
    const t = (await call<{ thing: { id: string } }>("POST", "/things", { name: "Mug" })).body.thing;
    const photo = await upload(t.id, await png(300, 300), "role=product");
    const cfg = await call<Record<string, any>>("GET", "/assets/config");
    expect(cfg.body.sf3d.ok).toBe(true);
    const gen = await call<Record<string, any>>("POST", `/things/${t.id}/assets/generate-model`, {
      fromAssetId: photo.body.asset.id,
    });
    expect(gen.status).toBe(201);
    expect(gen.body.asset).toMatchObject({
      role: "model",
      mime: "model/gltf-binary",
      source: "ai",
      data: { generator: "stable-fast-3d", fromAssetId: photo.body.asset.id },
    });
    expect(fakeSf3d.calls).toBe(1);
  });
});

describe("places tree and spots", () => {
  it("moves with a spot and lists places with counts", async () => {
    const mk = async (name: string, kind: string, parentId?: string) =>
      (
        await call<{ thing: { id: string } }>("POST", "/things", {
          name,
          kind,
          ...(parentId ? { parentId } : {}),
        })
      ).body.thing.id;
    const room = await mk("Tree room", "room");
    const ivar = await mk("Tree IVAR", "furniture", room);
    const crate = await mk("Tree crate", "container", ivar);
    await mk("Tree LEDs", "electronics", crate);
    const mv = await call<Record<string, any>>("POST", `/things/${crate}/move`, {
      to: ivar,
      position: "shelf 3",
    });
    expect(mv.body.thing.position).toBe("shelf 3");
    expect(mv.body.event.body).toMatchObject({
      type: "thing.moved",
      from: ivar,
      to: ivar,
      position: "shelf 3",
    });
    const tree = await call<{ places: any[]; unplaced: number }>("GET", "/places/tree");
    expect(tree.body.places.find((p) => p.id === room)).toMatchObject({ total: 1, items: 0 });
    expect(tree.body.places.find((p) => p.id === crate)).toMatchObject({ items: 1, position: "shelf 3" });
    const detail = await call<Record<string, any>>("GET", `/things/${crate}`);
    expect(detail.body.spots).toEqual(["shelf 3"]);
  });
});

describe("local models skip confirmation (D-017)", () => {
  it("quotes a local model as auto-approved, a paid one not", async () => {
    const store = Store.open(":memory:", aiMigrations);
    const local: Provider = {
      id: "lmstudio",
      configured: true,
      countTokens: async () => ({ tokens: 500, exact: false }),
      complete: fake.complete.bind(fake) as Provider["complete"],
    } as Provider;
    const gw = new AiGateway(store.db, [local, new FakeAnthropic()]);
    gw.register(suggestThingTask(store));
    const lq = await gw.quote("suggest-thing", { name: "kettle" }, "lmstudio", "google/gemma-4-31b");
    expect(lq).toMatchObject({ autoApprove: true, estCostUsd: null });
    const pq = await gw.quote("suggest-thing", { name: "kettle" }, "anthropic", "claude-haiku-5-5");
    expect(pq.autoApprove).toBe(false);
  });
});
