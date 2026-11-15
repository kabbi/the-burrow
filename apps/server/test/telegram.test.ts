import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { z } from "zod";
import { Store } from "@burrow/core";
import { createDeps, type Deps } from "../src/app.ts";
import { config } from "../src/config.ts";
import { AiGateway, aiMigrations } from "../src/ai/gateway.ts";
import type { Provider, ProviderId, SendPrompt } from "../src/ai/providers.ts";
import { photoThingTask } from "../src/ai/tasks.ts";
import type { VisualHit, VisualMatcher } from "../src/vision.ts";
import { Media } from "../src/media.ts";
import type { BotApi, TgMessage, TgUpdate } from "../src/telegram/api.ts";
import { PhotoBot, telegramMigrations } from "../src/telegram/bot.ts";

const CHAT = 4242;

/** A vision model that answers "glue gun" and judges candidates by name. */
class FakeVision implements Provider {
  readonly id: ProviderId;
  readonly configured = true;
  fail = false;
  answer: Record<string, unknown> = {};
  calls: { task: string; images: number; noThinking: boolean }[] = [];
  constructor(id: ProviderId) {
    this.id = id;
  }
  async countTokens() {
    return { tokens: 1200, exact: this.id === "anthropic" };
  }
  async complete<O>(p: SendPrompt, model: string, schema: z.ZodType<O>) {
    if (this.fail) throw new Error('LM Studio model "x" is not loaded');
    this.calls.push({ task: "photo", images: p.imageData?.length ?? 0, noThinking: Boolean(p.noThinking) });
    const output = {
      name: "Hot glue gun",
      kind: "tool",
      description: "Melts glue sticks for quick bonding.",
      maker: null,
      model: null,
      quantity: null,
      placeId: null,
      lookFor: ["glue gun", "glue", "hot melt"],
      ...this.answer,
    };
    return { output: schema.parse(output), model, inputTokens: 1000, outputTokens: 100 };
  }
}

/** Pretends the photo looks like whatever `hits` says. */
class FakeLooks implements VisualMatcher {
  hits: VisualHit[] = [];
  async similar() {
    return this.hits;
  }
  async refresh() {
    return 0;
  }
}

class FakeTelegram implements BotApi {
  calls: { method: string; params: Record<string, unknown>; id: number }[] = [];
  private n = 100;
  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.n++;
    this.calls.push({ method, params, id });
    return { message_id: id, chat: { id: CHAT, type: "private" }, date: 0 } as T;
  }
  /** The last "reply to me" prompt. */
  promptId() {
    return this.calls.filter((c) => JSON.stringify(c.params).includes("force_reply")).at(-1)!.id;
  }
  /** The message the last menu edit went to. */
  menuId() {
    return Number(this.calls.filter((c) => c.method.startsWith("editMessage")).at(-1)!.params.message_id);
  }
  async sendPhoto(_chat: number, _photo: Buffer, params: Record<string, unknown>): Promise<TgMessage> {
    return this.call("sendPhoto", params);
  }
  async download() {
    return sharp({ create: { width: 900, height: 700, channels: 3, background: "#c33" } })
      .jpeg()
      .toBuffer();
  }
  last(method: string) {
    return this.calls.filter((c) => c.method === method).at(-1)?.params;
  }
  buttons(): string[] {
    const m = this.calls.filter((c) => c.params.reply_markup).at(-1)?.params.reply_markup as
      | { inline_keyboard: { callback_data: string }[][] }
      | undefined;
    return m?.inline_keyboard.flat().map((b) => b.callback_data) ?? [];
  }
}

let deps: Deps;
let tg: FakeTelegram;
let local: FakeVision;
let claude: FakeVision;
let looks: FakeLooks;
let bot: PhotoBot;
let garage: string;
let glue: string;
let upd = 1;

const photo = (caption?: string): TgUpdate => ({
  update_id: upd++,
  message: {
    message_id: upd,
    chat: { id: CHAT, type: "private" },
    date: 0,
    photo: [{ file_id: "f", width: 900, height: 700 }],
    ...(caption ? { caption } : {}),
  },
});
const album = (n: number): TgUpdate[] => {
  const group = `g${upd}`;
  return Array.from({ length: n }, () => {
    const u = photo();
    u.message!.media_group_id = group;
    return u;
  });
};
const press = (data: string): TgUpdate => ({
  update_id: upd++,
  callback_query: {
    id: `cb${upd}`,
    from: { id: CHAT },
    message: { message_id: 1, chat: { id: CHAT, type: "private" }, date: 0 },
    data,
  },
});
const text = (t: string, replyTo?: number): TgUpdate => ({
  update_id: upd++,
  message: {
    message_id: upd,
    chat: { id: CHAT, type: "private" },
    date: 0,
    text: t,
    ...(replyTo
      ? { reply_to_message: { message_id: replyTo, chat: { id: CHAT, type: "private" }, date: 0 } }
      : {}),
  },
});
async function send(u: TgUpdate | TgUpdate[]) {
  for (const x of [u].flat()) await bot.handle(x);
  await new Promise((r) => setTimeout(r, 5)); // the album timer
  await bot.idle();
}
const sessionId = () => Number(tg.buttons()[0]!.split(":")[0]);

beforeEach(async () => {
  const store = Store.open(":memory:", [...aiMigrations, ...telegramMigrations]);
  const media = new Media(mkdtempSync(join(tmpdir(), "burrow-tg-")));
  local = new FakeVision("lmstudio");
  claude = new FakeVision("anthropic");
  const ai = new AiGateway(store.db, [local, claude], { loadImage: (f) => media.forModel(f) });
  ai.register(photoThingTask(store));
  deps = createDeps(
    {
      ...config,
      auth: false,
      mediaDir: media.dir,
      telegram: { token: "x", enabled: true, chats: [String(CHAT)] },
    },
    {
      store,
      ai,
      media,
      vision: (looks = new FakeLooks()),
      lmstudio: local as unknown as Deps["lmstudio"],
      anthropic: claude as unknown as Deps["anthropic"],
    },
  );
  garage = store.createThing({ name: "Garage", kind: "room" }).id;
  glue = store.createThing({ name: "Glue gun", kind: "tool", parentId: garage }).id;
  const pic = await media.ingest(await new FakeTelegram().download(), "a.jpg");
  store.addAsset(glue, { role: "photo", file: pic.file, mime: pic.mime, bytes: pic.bytes });
  const wood = store.createThing({ name: "Wood glue", kind: "thing" }).id;
  store.addAsset(wood, { role: "photo", file: pic.file, mime: pic.mime, bytes: pic.bytes });
  looks.hits = [
    { thingId: glue, score: 0.91 },
    { thingId: wood, score: 0.3 }, // has a picture that doesn't look like it: not shown even though the name matches
  ];
  tg = new FakeTelegram();
  bot = new PhotoBot(deps, tg, { albumDelayMs: 0 });
});

describe("telegram photo bot", () => {
  it("finds the thing you already have, adds the photo to it, and undoes", async () => {
    await send(photo());
    expect(local.calls).toEqual([{ task: "photo", images: 1, noThinking: true }]);
    // Candidates with pictures → a numbered contact sheet as the menu.
    const menu = tg.last("sendPhoto")!;
    expect(String(menu.caption)).toContain("Looks like your");
    expect(String(menu.caption)).toContain("Glue gun");
    expect(String(menu.caption)).toContain("91% alike");
    expect(String(menu.caption)).not.toContain("Wood glue");
    const sid = sessionId();
    expect(tg.buttons()).toContain(`${sid}:a:${glue}`);

    await send(press(`${sid}:a:${glue}`));
    expect(deps.store.assets(glue)).toHaveLength(2);
    expect(String(tg.last("editMessageCaption")!.caption)).toContain("Photo added to");
    expect(tg.buttons()).toContain(`${sid}:v`); // make it the cover

    await send(press(`${sid}:u`));
    expect(deps.store.assets(glue)).toHaveLength(1);
    expect(tg.buttons()).toContain(`${sid}:n`); // back to the choice
  });

  it("adds a new thing with the AI's details and puts it in a place you name", async () => {
    await send(photo());
    const sid = sessionId();
    await send(press(`${sid}:n`));
    const t = deps.store.list({ limit: 50 }).find((x) => x.name === "Hot glue gun")!;
    expect(t.kind).toBe("tool");
    expect(t.meta.name?.source).toBe("ai");
    expect(t.tags).toEqual([]); // AI suggests no tags (D-030)
    expect(t.cover).not.toBeNull();
    expect(t.parentId).toBeNull(); // never placed by guess

    const before = tg.calls.length;
    await send(press(`${sid}:P`));
    // No extra "which place?" message: you reply to the menu itself.
    expect(tg.calls.slice(before).some((c) => c.method === "sendMessage")).toBe(false);
    await send(text("garage, top shelf", tg.menuId()));
    const moved = deps.store.mustGet(t.id);
    expect(moved.parentId).toBe(garage);
    expect(moved.position).toBe("top shelf");
  });

  it("adds an album as one new thing per photo, without asking", async () => {
    looks.hits = [];
    await send(album(3));
    expect(local.calls).toHaveLength(3); // one at a time, one photo each
    const made = deps.store.list({ limit: 50 }).filter((x) => x.name === "Hot glue gun");
    expect(made).toHaveLength(3);
    for (const t of made) {
      expect(t.meta.name?.source).toBe("ai"); // violet until you say it's right
      expect(t.kind).toBe("tool");
      expect(t.cover).not.toBeNull();
    }
    const summary = String(tg.last("editMessageText")!.text);
    expect(summary).toContain("3 new things");
    expect(summary).toContain("2 dog nail clipper");
  });

  it("fixes a wrong guess from the batch: your name, details redone", async () => {
    looks.hits = [];
    await send(album(2));
    const batchMenu = tg.menuId();
    const second = deps.store.list({ limit: 50 }).filter((x) => x.name === "Hot glue gun")[0]!;
    local.answer = {
      name: "Dog nail clipper",
      kind: "thing",
      description: "Trims a dog's nails.",
    };
    await send(text("2 dog nail clipper", batchMenu));
    const t = deps.store.mustGet(second.id);
    expect(t.name).toBe("dog nail clipper");
    expect(t.meta.name?.source).toBe("you");
    expect(t.data.description).toBe("Trims a dog's nails.");
    expect(t.tags).toEqual([]);
    expect(String(tg.last("editMessageText")!.text)).toContain("dog nail clipper");
  });

  it("puts a whole batch in one place, or makes it one thing after all", async () => {
    looks.hits = [];
    await send(album(2));
    const sid = Number(
      tg
        .buttons()
        .find((b) => b.endsWith(":P"))!
        .split(":")[0],
    );
    await send(press(`${sid}:P`));
    await send(text("garage", tg.menuId()));
    const made = deps.store.list({ limit: 50 }).filter((x) => x.name === "Hot glue gun");
    expect(made.map((x) => x.parentId)).toEqual([garage, garage]);

    await send(press(`${sid}:1`));
    expect(deps.store.list({ limit: 50 }).filter((x) => x.name === "Hot glue gun")).toHaveLength(0);
    expect(tg.buttons()).toContain(`${sid}:n`); // the one-thing menu
    await send(press(`${sid}:n`));
    const one = deps.store.list({ limit: 50 }).filter((x) => x.name === "Hot glue gun");
    expect(one).toHaveLength(1);
    expect(deps.store.assets(one[0]!.id)).toHaveLength(2);
  });

  it("flags a batch photo that looks like a thing you have; one tap moves it there", async () => {
    await send(album(2));
    expect(String(tg.last("editMessageText")!.text)).toContain("looks like your");
    const item = tg.buttons().find((b) => b.endsWith(":o"))!;
    await send(press(item));
    const cid = item.split(":")[0];
    expect(tg.buttons()).toContain(`${cid}:m:${glue}`);
    const made = deps.store.list({ limit: 50 }).filter((x) => x.name === "Hot glue gun").length;
    await send(press(`${cid}:m:${glue}`));
    expect(deps.store.assets(glue)).toHaveLength(2);
    expect(deps.store.list({ limit: 50 }).filter((x) => x.name === "Hot glue gun")).toHaveLength(made - 1);
  });

  it("names it yourself", async () => {
    await send(photo());
    await send(press(`${sessionId()}:N`));
    await send(text("My glue gun", tg.promptId()));
    const t = deps.store.list({ limit: 50 }).find((x) => x.name === "My glue gun")!;
    expect(t.meta.name?.source).toBe("you");
    expect(t.kind).toBe("tool");
  });

  it("asks before using Claude when the local model is away, and shows the price", async () => {
    local.fail = true;
    await send(photo());
    expect(claude.calls).toHaveLength(0);
    const menu = tg.last("editMessageText")!;
    expect(String(menu.text)).toContain("Ask Claude instead?");
    const sid = sessionId();
    expect(tg.buttons()).toEqual([`${sid}:c`, `${sid}:s`, `${sid}:x`]);
    await send(press(`${sid}:c`));
    expect(claude.calls).toEqual([{ task: "photo", images: 1, noThinking: true }]);
    expect(tg.buttons()).toContain(`${sid}:n`);
  });

  it("searches by text and keeps strangers out", async () => {
    await send(text("glue gun"));
    expect(String(tg.last("sendPhoto")!.caption)).toContain("Garage");
    await bot.handle({
      update_id: upd++,
      message: { message_id: 1, chat: { id: 999, type: "private" }, date: 0, text: "hi" },
    });
    expect(String(tg.last("sendMessage")!.text)).toContain("This is a private bot.");
  });

  it("lets a stranger in after they send a link code from Burrow", async () => {
    const a = await deps.accounts.create({ username: "anna", name: "Anna", password: "anna's first" });
    const msg = (t: string): TgUpdate => ({
      update_id: upd++,
      message: { message_id: upd, chat: { id: 777, type: "private" }, from: { id: 777 }, date: 0, text: t },
    });
    await send(msg("/start NOPE1234"));
    expect(String(tg.last("sendMessage")!.text)).toContain("didn't work");
    const { code } = deps.accounts.telegramCode(a.username);
    await send(msg(`/start ${code}`));
    expect(String(tg.last("sendMessage")!.text)).toContain("Linked: you are <b>Anna</b>");
    await send(msg("glue gun"));
    expect(String(tg.last("sendPhoto")!.caption)).toContain("Garage");
    // What a linked person does is theirs.
    await send({
      ...photo("Anna's photo"),
      message: { ...photo("Anna's photo").message!, chat: { id: 777, type: "private" }, from: { id: 777 } },
    });
    await send(press(`${sessionId()}:n`));
    const created = deps.store.events({ types: ["thing.created"], limit: 1 })[0]!;
    expect(created.actor).toBe("anna");
  });
});
