import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@burrow/core";
import { createApp, createDeps, type Deps } from "../src/app.ts";
import { config } from "../src/config.ts";
import { tokenMigrations } from "../src/api/tokens.ts";
import { PaperlessMock } from "../src/adapters/paperless-mock.ts";

// Sign-in and attribution with auth on (D-032).

let server: Server;
let base = "";
let deps: Deps;

/** A browser: keeps the session cookie between calls. */
function browser() {
  let cookie = "";
  return async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
    const text = await res.text();
    return {
      status: res.status,
      body: (text.startsWith("{") ? JSON.parse(text) : {}) as T & { error?: string },
    };
  };
}

beforeAll(async () => {
  const store = Store.open(":memory:", tokenMigrations);
  deps = createDeps(
    { ...config, auth: true, mediaDir: mkdtempSync(join(tmpdir(), "burrow-auth-")) },
    { store, paperless: new PaperlessMock() },
  );
  // Before accounts, everything was "you".
  store.createThing({ name: "Old lamp" });
  server = createApp(deps).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const owner = browser();
const anon = browser();

describe("sign-in", () => {
  it("asks for the first account, and only then", async () => {
    expect((await anon("GET", "/api/health")).status).toBe(200);
    expect((await anon("GET", "/api/things")).status).toBe(401);
    expect((await anon("GET", "/media/x.jpg")).status).toBe(401);
    const st = await anon<{ needsSetup: boolean; me: null }>("GET", "/api/auth/state");
    expect(st.body).toMatchObject({ needsSetup: true, me: null });

    const setup = await owner<{ me: { username: string; personId: string; name: string } }>(
      "POST",
      "/api/auth/setup",
      { username: "Kabbi", name: "Dmitry", password: "correct horse" },
    );
    expect(setup.status).toBe(200);
    expect(setup.body.me).toMatchObject({ username: "kabbi", name: "Dmitry" });
    const person = deps.store.mustGet(setup.body.me.personId);
    expect(person.kind).toBe("person");

    expect(
      (await anon("POST", "/api/auth/setup", { username: "eve", name: "", password: "12345678" })).status,
    ).toBe(409);
    expect((await anon<{ needsSetup: boolean }>("GET", "/api/auth/state")).body.needsSetup).toBe(false);
    expect((await owner("GET", "/api/things")).status).toBe(200);
  });

  it("attributes writes to the signed-in account", async () => {
    const r = await owner<{ thing: { id: string } }>("POST", "/api/things", { name: "Drill" });
    expect(r.status).toBe(201);
    const [created] = deps.store.events({ thingId: r.body.thing.id });
    expect(created!.actor).toBe("kabbi");
    // A move keeps "you" as the provenance of the place (a person did it), whoever the actor is.
    const room = deps.store.createThing({ name: "Garage", kind: "room" });
    await owner("POST", `/api/things/${r.body.thing.id}/move`, { to: room.id });
    expect(deps.store.mustGet(r.body.thing.id).meta.parent?.source).toBe("you");
    // Undo is the person's too.
    const ev = deps.store.events({ thingId: r.body.thing.id, limit: 1 })[0]!;
    await owner("POST", `/api/events/${ev.seq}/undo`);
    expect(deps.store.events({ thingId: r.body.thing.id, limit: 1, includeUndos: true })[0]!.actor).toBe(
      "kabbi",
    );
  });

  it("names the pre-accounts actor after the first account", async () => {
    const r = await owner<{ legacyOwner: string; accounts: { username: string }[] }>("GET", "/api/accounts");
    expect(r.body.legacyOwner).toBe("kabbi");
  });

  it("refuses wrong passwords, slowly, and cross-origin writes", async () => {
    const eve = browser();
    expect((await eve("POST", "/api/auth/login", { username: "kabbi", password: "nope" })).status).toBe(401);
    expect((await eve("POST", "/api/auth/login", { username: "nobody", password: "nope" })).status).toBe(401);
    for (let i = 0; i < 4; i++) await eve("POST", "/api/auth/login", { username: "kabbi", password: "nope" });
    expect(
      (await eve("POST", "/api/auth/login", { username: "kabbi", password: "correct horse" })).status,
    ).toBe(429);
    const x = await owner("POST", "/api/things", { name: "Evil" }, { origin: "https://evil.example.com" });
    expect(x.status).toBe(403);
  });

  it("adds people, links things to them, and keeps names apart from apps", async () => {
    const add = await owner<{ account: { username: string; personId: string } }>("POST", "/api/accounts", {
      username: "anna",
      name: "Anna",
      password: "anna's first",
    });
    expect(add.status).toBe(201);
    const [made] = deps.store.events({ thingId: add.body.account.personId });
    expect(made!.actor).toBe("kabbi");

    // People are link targets: owned by / bought by / author only point at persons.
    const lamp = deps.store.createThing({ name: "Lamp" });
    const ok = await owner("POST", `/api/things/${lamp.id}/relations`, {
      type: "owned_by",
      otherId: add.body.account.personId,
    });
    expect(ok.status).toBe(201);
    const bad = await owner("POST", `/api/things/${lamp.id}/relations`, {
      type: "bought_by",
      otherId: lamp.id,
    });
    expect(bad.status).toBe(400);

    // A username can't be an app's actor and the other way round.
    expect((await owner("POST", "/api/tokens", { name: "x", actor: "anna", scopes: ["read"] })).status).toBe(
      409,
    );
    await owner("POST", "/api/tokens", { name: "Rig", actor: "pcb-rig", scopes: ["read"] });
    const clash = await owner("POST", "/api/accounts", {
      username: "pcb-rig",
      name: "",
      password: "whatever1",
    });
    expect(clash.status).toBe(409);
    expect(
      (await owner("POST", "/api/accounts", { username: "ai", name: "", password: "whatever1" })).status,
    ).toBe(409);

    const anna = browser();
    expect(
      (await anna("POST", "/api/auth/login", { username: "anna", password: "anna's first" })).status,
    ).toBe(200);
    const t = await anna<{ thing: { id: string } }>("POST", "/api/things", { name: "Anna's mug" });
    expect(deps.store.events({ thingId: t.body.thing.id })[0]!.actor).toBe("anna");
  });

  it("changes passwords and signs out", async () => {
    const laptop = browser();
    await laptop("POST", "/api/auth/login", { username: "anna", password: "anna's first" });
    const anna = browser();
    await anna("POST", "/api/auth/login", { username: "anna", password: "anna's first" });
    expect(
      (await anna("POST", "/api/account/password", { current: "wrong", next: "anna's second" })).status,
    ).toBe(403);
    expect(
      (await anna("POST", "/api/account/password", { current: "anna's first", next: "short" })).status,
    ).toBe(400);
    expect(
      (await anna("POST", "/api/account/password", { current: "anna's first", next: "anna's second" }))
        .status,
    ).toBe(200);
    // Other sessions end with the old password; this one stays.
    expect((await laptop("GET", "/api/things")).status).toBe(401);
    expect((await anna("GET", "/api/things")).status).toBe(200);
    await anna("POST", "/api/auth/logout");
    expect((await anna("GET", "/api/things")).status).toBe(401);
  });

  it("links a Telegram id to one account", async () => {
    const r = await owner<{ me: { telegramId: string } }>("PATCH", "/api/account", { telegramId: "4242" });
    expect(r.body.me.telegramId).toBe("4242");
    expect(deps.accounts.byTelegram(4242)?.username).toBe("kabbi");
    expect((await owner("PATCH", "/api/account", { telegramId: "abc" })).status).toBe(400);
  });

  it("starts passkey sign-in only for this site's origin", async () => {
    const host = new URL(base).host;
    const ok = await anon<{ challengeId: string; options: { rpId: string } }>(
      "POST",
      "/api/auth/passkey/options",
      {},
      { origin: `http://${host}` },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.options.rpId).toBe("127.0.0.1");
    expect((await anon("POST", "/api/auth/passkey/options", {})).status).toBe(400);
  });
});
