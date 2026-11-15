import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { Store } from "@burrow/core";
import { createApp, createDeps, type Deps } from "../src/app.ts";
import { config } from "../src/config.ts";
import { tokenMigrations } from "../src/api/tokens.ts";
import { v1Ops } from "../src/api/v1.ts";
import type { AnyOp } from "../src/api/define.ts";
import { Event } from "../src/api/schemas.ts";

let server: Server;
let base = "";
let deps: Deps;
let ops: AnyOp[];
let rig = "";
let reader = "";

/** Call the API and check the answer against what the docs promise for that operation. */
async function call<T = Record<string, unknown>>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T & { error?: string; events: z.infer<typeof Event>[] } }> {
  const form = body instanceof FormData;
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !form ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as T & { error?: string; events: z.infer<typeof Event>[] };
  if (res.ok) {
    const o = ops.find((x) => x.method === method.toLowerCase() && matches(x.path, path.split("?")[0]!));
    if (!o) throw new Error(`no documented operation for ${method} ${path}`);
    const schema =
      o.scope === "read" ? o.response : (o.response as z.ZodObject).extend({ events: z.array(Event) });
    const checked = schema.safeParse(json);
    if (!checked.success) throw new Error(`${o.id} answered off-spec: ${checked.error.message}`);
    if (res.status !== (o.status ?? 200)) throw new Error(`${o.id} answered ${res.status}`);
  }
  return { status: res.status, body: json };
}
const matches = (tpl: string, path: string) => new RegExp(`^${tpl.replace(/\{\w+\}/g, "[^/]+")}$`).test(path);

const picture = (color: string) =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
    .jpeg()
    .toBuffer();

beforeAll(async () => {
  const store = Store.open(":memory:", tokenMigrations);
  deps = createDeps({ ...config, mediaDir: mkdtempSync(join(tmpdir(), "burrow-v1-")) }, { store });
  ops = v1Ops(deps);
  rig = deps.tokens.create({ name: "PCB rig", actor: "pcb-rig", scopes: ["write"] }).token;
  reader = deps.tokens.create({ name: "Dashboard", actor: "dashboard", scopes: ["read"] }).token;
  server = createApp(deps).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("API v1", () => {
  it("needs a live token with the right scope", async () => {
    expect((await call("", "GET", "/things")).status).toBe(401);
    expect((await call("bur_nope", "GET", "/things")).status).toBe(401);
    const me = await call<{ token: { actor: string; scopes: string[] } }>(reader, "GET", "/me");
    expect(me.body.token).toMatchObject({ actor: "dashboard", scopes: ["read"] });
    expect((await call(reader, "POST", "/things", { name: "x" })).status).toBe(403);
    expect((await call(rig, "PUT", "/kinds/plant", { name: "Plant" })).status).toBe(403);

    const t = deps.tokens.create({ name: "old", actor: "old-app", scopes: ["read"] });
    expect((await call(t.token, "GET", "/me")).status).toBe(200);
    deps.tokens.revoke(t.info.id);
    expect((await call(t.token, "GET", "/me")).status).toBe(401);
    expect(() => deps.tokens.create({ name: "sneaky", actor: "you", scopes: ["write"] })).toThrow(/reserved/);
  });

  it("syncs a thing by ref, attributed to the app, without overwriting what a person set", async () => {
    const put = await call<{
      thing: { id: string; path: { name: string }[]; tags: { name: string }[] };
      created: boolean;
    }>(rig, "PUT", "/refs/pcbphoto/board-17", {
      name: "ESP32 dev board",
      kind: "electronics",
      data: { maker: "Espressif", model: "DevKitC" },
      parentPath: "Workshop / Drawer 3",
      createPlaces: true,
      position: "front",
      tags: ["esp32", "dev board"],
    });
    expect(put.status).toBe(200);
    expect(put.body.created).toBe(true);
    const id = put.body.thing.id;
    expect(put.body.thing.path.map((p) => p.name)).toEqual(["Workshop", "Drawer 3"]);
    expect(put.body.thing.tags.map((t) => t.name).toSorted()).toEqual(["dev board", "esp32"]);
    // Every change is in the log under the app's name, and returned to the caller.
    expect(new Set(put.body.events.map((e) => e.actor))).toEqual(new Set(["pcb-rig"]));
    expect(put.body.events.map((e) => e.body.type)).toContain("ref.linked");
    const thing = deps.store.mustGet(id);
    expect(thing.meta.maker?.source).toBe("app");
    expect(thing.position).toBe("front");

    // A person fixes the model in Burrow; the next sync leaves it alone.
    deps.store.change(id, { data: { model: "DevKitC v4" } }, "you", "you");
    const again = await call<{
      created: boolean;
      skipped: string[];
      thing: { data: Record<string, unknown> };
    }>(rig, "PUT", "/refs/pcbphoto/board-17", {
      data: { model: "DevKitC", revision: "1.1" },
      addTags: ["wifi"],
    });
    expect(again.body.created).toBe(false);
    expect(again.body.skipped).toEqual(["model"]);
    expect(again.body.thing.data).toMatchObject({ model: "DevKitC v4", revision: "1.1" });
    expect(deps.store.mustGet(id).tags).toHaveLength(3);

    const found = await call<{ thing: { id: string } }>(reader, "GET", "/refs/pcbphoto/board-17");
    expect(found.body.thing.id).toBe(id);
    expect((await call(reader, "GET", "/refs/pcbphoto/nope")).status).toBe(404);
    // paperless refs stay Burrow's own.
    expect((await call(rig, "PUT", "/refs/paperless/1", { name: "x" })).status).toBe(403);
  });

  it("uploads files by key: the same key replaces in place", async () => {
    const t = await call<{ thing: { id: string } }>(rig, "POST", "/things", {
      name: "Level shifter",
      ref: { service: "pcbphoto", remoteId: "board-18" },
    });
    expect(t.status).toBe(201);
    const id = t.body.thing.id;
    const upload = async (color: string) => {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(await picture(color))], { type: "image/jpeg" }), "proc.jpg");
      form.set(
        "original",
        new Blob([new Uint8Array(await picture("#000"))], { type: "image/jpeg" }),
        "raw.jpg",
      );
      form.set("meta", JSON.stringify({ key: "pcbphoto:cap-1", data: { view: "top", pxPerMm: 20 } }));
      return call<{
        asset: { id: string; file: string; originalUrl: string | null; source: string };
        replaced: boolean;
      }>(rig, "POST", `/things/${id}/assets`, form);
    };
    const first = await upload("#c33");
    expect(first.status).toBe(201);
    expect(first.body.replaced).toBe(false);
    expect(first.body.asset.originalUrl).toMatch(/^\/media\//);
    expect(first.body.asset.source).toBe("app");
    const second = await upload("#3c3");
    expect(second.body.replaced).toBe(true);
    expect(second.body.asset.id).toBe(first.body.asset.id);
    expect(second.body.asset.file).not.toBe(first.body.asset.file);
    expect(deps.store.assets(id)).toHaveLength(1);
    expect(deps.store.mustGet(id).cover?.id).toBe(first.body.asset.id);

    const noFile = new FormData();
    noFile.set("meta", "{}");
    expect((await call(rig, "POST", `/things/${id}/assets`, noFile)).status).toBe(400);
  });

  it("follows changes with a cursor and undoes only its own", async () => {
    const start = deps.store.events({ limit: 1 })[0]!.seq;
    const made = await call<{ thing: { id: string } }>(rig, "POST", "/things", { name: "Soldering iron" });
    deps.store.setStatus(made.body.thing.id, "missing", undefined, "you");
    const feed = await call<{ events: { seq: number; actor: string; body: { type: string } }[] }>(
      reader,
      "GET",
      `/events?after=${start}`,
    );
    expect(feed.body.events.map((e) => [e.actor, e.body.type])).toEqual([
      ["pcb-rig", "thing.created"],
      ["you", "thing.status"],
    ]);
    const [mine, theirs] = feed.body.events;
    expect((await call(rig, "POST", `/events/${theirs!.seq}/undo`)).status).toBe(403);
    expect((await call(rig, "POST", `/events/${mine!.seq}/undo`)).status).toBe(200);
    expect(deps.store.getRaw(made.body.thing.id)?.archivedAt).not.toBeNull(); // undoing a create archives
    const byActor = await call<{ events: { actor: string }[] }>(
      reader,
      "GET",
      "/events?actor=pcb-rig&limit=500",
    );
    expect(byActor.body.events.every((e) => e.actor === "pcb-rig")).toBe(true);
  });

  it("changes schema with the schema scope, and reads the rest", async () => {
    const admin = deps.tokens.create({
      name: "admin",
      actor: "admin-script",
      scopes: ["schema", "write"],
    }).token;
    const k = await call<{ kind: { effectiveFields: { key: string }[] } }>(admin, "PUT", "/kinds/plant", {
      name: "Plant",
      parent: "thing",
      fields: [{ key: "watering", label: "Watering", type: "select", options: ["weekly", "daily"] }],
    });
    expect(k.status).toBe(200);
    expect(k.body.kind.effectiveFields.map((f) => f.key)).toContain("watering");
    await call(reader, "GET", "/schema");
    await call(reader, "GET", "/places");
    await call(reader, "GET", "/places/tree");
    await call(reader, "GET", "/tags");
    await call(reader, "GET", "/search?q=esp32");
    await call(reader, "GET", "/things?order=name&limit=5");
    await call(reader, "GET", "/stats");
    await call(reader, "GET", "/needs-details");
    const place = await call<{ place: { name: string } }>(reader, "POST", "/places/resolve", {
      path: "workshop/drawer 3",
    });
    expect(place.body.place.name).toBe("Drawer 3");
    expect((await call(reader, "POST", "/places/resolve", { path: "Attic", create: true })).status).toBe(403);
  });

  it("describes itself", async () => {
    const res = await fetch(`${base}/api/v1/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string; summary: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.openapi).toBe("3.1.0");
    const listed = Object.values(spec.paths).flatMap((p) => Object.values(p));
    expect(listed).toHaveLength(ops.length);
    expect(new Set(listed.map((o) => o.operationId)).size).toBe(ops.length);
    for (const o of listed) expect(o.summary).toBeTruthy();
    const refs = new Set(
      [...JSON.stringify(spec).matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1]!),
    );
    for (const r of refs) expect(spec.components.schemas).toHaveProperty(r);
    // …and has a readable version (Redoc, served locally).
    const html = await fetch(`${base}/api/v1`);
    expect(html.headers.get("content-type")).toMatch(/html/);
    expect(await html.text()).toContain("/api/v1/openapi.json");
    const js = await fetch(`${base}/api/v1/redoc.standalone.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(
      (await fetch(`${base}/api/v1/nope`, { headers: { authorization: `Bearer ${reader}` } })).status,
    ).toBe(404);
  });
});
