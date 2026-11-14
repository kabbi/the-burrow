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
  const deps = createDeps(config, { store, ai, paperless: new PaperlessMock(), inboxTagNames: ["inbox"] });
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
        meta: Record<string, { source: string }>;
      };
    }>("POST", "/things/B-0002/apply-suggestion", { requestId: q.body.quote.id, reject: ["maker"] });
    expect(applied.body.thing.name).toBe("Moka pot, 6-cup");
    expect(applied.body.thing.data.maker).toBeUndefined();
    expect(applied.body.thing.data.tags).toEqual(["coffee", "kitchen"]);
    expect(applied.body.thing.meta.tags?.source).toBe("ai");
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

    const thing = await call<{ documents: { toId: string }[] }>("GET", "/things/B-0002");
    expect(thing.body.documents.map((e) => e.toId)).toEqual(["paperless:101"]);
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
