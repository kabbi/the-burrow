import sharp from "sharp";
import type { Migration, Store, ThingView } from "@burrow/core";
import type { Deps } from "../app.ts";
import type { Ingested } from "../media.ts";
import type { PhotoSuggestion } from "../ai/tasks.ts";
import { runAs } from "../auth/context.ts";
import { applySuggestion } from "../routes/things.ts";
import { esc, type BotApi, type Keyboard, type TgCallback, type TgMessage, type TgUpdate } from "./api.ts";

// Telegram photo bot (D-019): send a photo, get "new thing" or "it's one of these"
// (add the photo to it / show where it is). Matching is by looks (vision.ts, CPU) plus the
// local vision model's description;
// Claude is only used after the person taps a button that shows its price.
// An album is a batch (D-029): one new thing per photo straight away, guesses filled in afterwards.

export const telegramMigrations: Migration[] = [
  {
    id: "telegram/001-sessions",
    sql: `
      create table tg_sessions (
        id integer primary key,
        chat_id integer not null,
        created_at text not null,
        updated_at text not null,
        status text not null,          -- looking | quote | ready | added | attached | discarded | failed
        photos text not null default '[]',
        caption text,
        suggestion text,               -- PhotoSuggestion json (null = no AI)
        candidates text not null default '[]',  -- [{id, via, score}]
        thing_id text,                 -- the thing the photos ended up on
        asset_ids text not null default '[]',
        quote_id text,                 -- a Claude quote waiting for a yes
        menu_id integer,               -- the bot message with the buttons
        menu_photo integer not null default 0,
        prompt_id integer,             -- a "reply to me" prompt
        awaiting text,                 -- name | rename | place
        extra text not null default '{}',
        error text
      );
      create index tg_sessions_prompt on tg_sessions(chat_id, prompt_id);
      create table tg_state (key text primary key, value text not null);
    `,
  },
];

type Status = "looking" | "quote" | "ready" | "added" | "attached" | "discarded" | "failed" | "batch";
type Photo = Pick<Ingested, "file" | "mime" | "bytes" | "width" | "height" | "thumb">;

interface Session {
  id: number;
  chatId: number;
  status: Status;
  photos: Photo[];
  caption: string | null;
  suggestion: PhotoSuggestion | null;
  /** How each was found: by looks (cosine score), by name, or by an id in the caption. */
  candidates: { id: string; via: "looks" | "name" | "id"; score?: number; sure?: boolean }[];
  thingId: string | null;
  assetIds: string[];
  quoteId: string | null;
  menuId: number | null;
  menuPhoto: boolean;
  promptId: number | null;
  awaiting: "name" | "rename" | "place" | null;
  extra: {
    spot?: string;
    placeOptions?: string[];
    /** A batch's photos, one session each (D-029). */
    items?: number[];
    /** The batch this photo came in. */
    batchOf?: number;
    /** Still waiting for the AI and the look-alike search. */
    pending?: boolean;
    /** Why the batch went without AI. */
    noAi?: string;
  };
  error: string | null;
}

const MAX_CANDIDATES = 3;
const MAX_PHOTOS_TO_AI = 3;
const SEARCH_POOL = 12;
/**
 * Cosine similarity (DINOv2) worth showing. "That's it" (🎯) needs a high score *and* a clear lead
 * over the runner-up: similar objects shot the same way (PCBs on white) all score ~0.9 (2026-11-14).
 */
const LOOKS_MIN = 0.5;
const LOOKS_SAME = 0.85;
const LOOKS_LEAD = 0.04;
/** A batch thing's name until the AI (or you) names it. */
const PLACEHOLDER = "Photo from Telegram";

export interface BotOptions {
  /** How long to wait for the rest of an album (ms). */
  albumDelayMs?: number;
}

export class PhotoBot {
  private deps: Deps;
  private api: BotApi;
  private albums = new Map<string, { msgs: TgMessage[]; timer: NodeJS.Timeout }>();
  private work = new Set<Promise<unknown>>();
  private albumDelayMs: number;
  /** Chats let in by the environment (TG_ADMIN_CHAT_ID, TG_ALLOWED_CHAT_IDS); linked accounts are too. */
  private allowed: Set<string>;
  private warnedChats = new Set<number>();
  private badCodes = new Map<number, { n: number; until: number }>();

  constructor(deps: Deps, api: BotApi, opts: BotOptions = {}) {
    this.deps = deps;
    this.api = api;
    this.albumDelayMs = opts.albumDelayMs ?? 1200;
    this.allowed = new Set(deps.config.telegram.chats);
  }

  private get store(): Store {
    return this.deps.store;
  }

  /** Resolves when background work (downloads, AI) started so far is done. For tests. */
  async idle() {
    while (this.work.size) await Promise.allSettled(this.work);
  }

  private track(p: Promise<unknown>) {
    const q = p.catch((e: Error) => console.error("telegram:", e)).finally(() => this.work.delete(q));
    this.work.add(q);
  }

  // ------------------------------------------------------------ updates

  /** Each update acts as the Burrow account linked to the sender's Telegram id (D-032). */
  async handle(u: TgUpdate) {
    const from = u.callback_query?.from ?? u.message?.from;
    const account = from ? this.deps.accounts.byTelegram(from.id) : null;
    return runAs(account?.username ?? "telegram", () => this.handleUpdate(u));
  }

  /** Let in: a chat from the environment, or a sender linked to a Burrow account. */
  private lets(chatId: number, fromId: number | undefined) {
    return (
      this.allowed.has(String(chatId)) ||
      (fromId !== undefined && Boolean(this.deps.accounts.byTelegram(fromId)))
    );
  }

  private async handleUpdate(u: TgUpdate) {
    if (u.callback_query) return this.onCallback(u.callback_query);
    const m = u.message;
    if (!m) return;
    // "/start CODE" (from the account page's t.me link) or "/link CODE" links this Telegram user.
    const code = m.text?.trim().match(/^\/(?:start|link)(?:@\w+)?\s+([A-Za-z0-9]{6,32})$/)?.[1];
    if (code && m.from) return this.linkAccount(m.chat.id, m.from.id, code);
    if (!this.lets(m.chat.id, m.from?.id)) {
      if (!this.warnedChats.has(m.chat.id)) {
        this.warnedChats.add(m.chat.id);
        console.warn(`telegram: chat ${m.chat.id} (${m.from?.first_name ?? "?"}) isn't linked to an account`);
        await this.send(
          m.chat.id,
          `This is a private bot. To use it, open your account page in Burrow (${esc(this.deps.config.publicUrl)}/account) and tap “Connect Telegram”.`,
        );
      }
      return;
    }
    if (isImage(m)) {
      if (!m.media_group_id) return this.track(this.newSession([m]));
      // Albums arrive as separate messages: collect them, then treat them as one thing.
      const a = this.albums.get(m.media_group_id);
      if (a) clearTimeout(a.timer);
      const msgs = [...(a?.msgs ?? []), m];
      const id = m.media_group_id;
      const timer = setTimeout(() => {
        this.albums.delete(id);
        this.track(msgs.length > 1 ? this.newBatch(msgs) : this.newSession(msgs));
      }, this.albumDelayMs);
      this.albums.set(id, { msgs, timer });
      return;
    }
    if (m.text) return this.onText(m);
  }

  private async onText(m: TgMessage) {
    const text = m.text!.trim();
    const replyTo = m.reply_to_message?.message_id;
    if (replyTo) {
      const s = this.findByPrompt(m.chat.id, replyTo);
      if (s) return this.onAnswer(s, text);
      const b = this.findBatch(m.chat.id, replyTo);
      if (b) return this.onBatchReply(b, text);
    }
    if (/^\/(start|help)\b/.test(text)) return this.send(m.chat.id, HELP);
    if (/^\/me\b/.test(text)) return this.send(m.chat.id, this.whoami(m));
    const q = text.replace(/^\/find(@\w+)?\s*/, "").trim();
    if (!q) return this.send(m.chat.id, "What should I look for? E.g. “glue gun”.");
    return this.find(m.chat.id, q);
  }

  private async linkAccount(chatId: number, fromId: number, code: string) {
    const bad = this.badCodes.get(fromId);
    if (bad && bad.until > Date.now())
      return this.send(chatId, "Too many wrong codes. Try again in a few minutes.");
    const a = this.deps.accounts.redeemTelegramCode(code, fromId);
    if (!a) {
      const n = (bad?.n ?? 0) + 1;
      this.badCodes.set(fromId, { n, until: n >= 5 ? Date.now() + 10 * 60_000 : 0 });
      return this.send(
        chatId,
        "That code didn't work (it lasts 10 minutes). Make a new one on your account page in Burrow.",
      );
    }
    this.badCodes.delete(fromId);
    this.warnedChats.delete(chatId);
    return this.send(
      chatId,
      `🔗 Linked: you are <b>${esc(a.name)}</b> in Burrow. What you do here is recorded under your name.\n\n${HELP}`,
    );
  }

  /** Which Burrow account this Telegram user is, and how to link one. */
  private whoami(m: TgMessage): string {
    const id = m.from?.id;
    if (!id) return "I can't tell who you are here.";
    const a = this.deps.accounts.byTelegram(id);
    return a
      ? `You are <b>${esc(a.name)}</b> (${esc(a.username)}) in Burrow. What you do here is recorded under that name.`
      : `You aren't linked to a Burrow account. Open your account page (${esc(this.deps.config.publicUrl)}/account) and tap “Connect Telegram”.`;
  }

  /** Text that isn't a reply: find things and say where they are. */
  private async find(chatId: number, q: string) {
    const hits = this.store
      .search(q, 8)
      .map((h) => h.thing)
      .filter((t) => this.isItem(t));
    if (!hits.length) return this.send(chatId, `Nothing found for “${esc(q)}”.`);
    if (hits.length === 1) return this.sendCard(chatId, hits[0]!, null);
    const lines = hits.slice(0, 8).map((t, i) => `${i + 1}. ${this.link(t)}${this.where(t, " — ")}`);
    return this.send(chatId, lines.join("\n"));
  }

  // ------------------------------------------------------------ a new photo

  private async newSession(msgs: TgMessage[]) {
    const first = msgs[0]!;
    const chatId = first.chat.id;
    const caption = msgs.map((m) => m.caption?.trim()).find(Boolean) ?? null;
    const status = await this.send(chatId, "🔍 Looking…", { reply_to_message_id: first.message_id });
    const s = this.insert(chatId, "looking", caption, status.message_id);
    try {
      const photos: Photo[] = [];
      for (const m of msgs) photos.push(await this.fetchPhoto(m));
      s.photos = photos;
      this.save(s);
    } catch (e) {
      s.status = "failed";
      s.error = (e as Error).message;
      this.save(s);
      return this.editMenu(s, `😕 Couldn't get the photo: ${esc(s.error)}`, []);
    }
    await this.recognise(s);
  }

  private async fetchPhoto(m: TgMessage): Promise<Photo> {
    const fileId = m.photo?.at(-1)?.file_id ?? m.document!.file_id;
    const f = await this.deps.media.ingest(
      await this.api.download(fileId),
      m.document?.file_name ?? "photo.jpg",
    );
    if (f.kind !== "image") throw new Error("That file isn't a picture");
    return {
      file: f.file,
      mime: f.mime,
      bytes: f.bytes,
      ...(f.width ? { width: f.width } : {}),
      ...(f.height ? { height: f.height } : {}),
      ...(f.thumb ? { thumb: f.thumb } : {}),
    };
  }

  /** The local vision model's guess (free, never asks). `why` says why there is none. */
  private async localGuess(
    photos: Photo[],
    caption: string | null,
  ): Promise<{ sg: PhotoSuggestion | null; why: string }> {
    const { ai, config, lmstudio } = this.deps;
    const input = {
      images: photos.slice(0, MAX_PHOTOS_TO_AI).map((p) => p.file),
      ...(caption ? { caption } : {}),
    };
    let why = "it isn't set up";
    if (lmstudio.configured) {
      try {
        const q = await ai.quote("photo-thing", input, "lmstudio", config.ai.lmstudioModel);
        const rec = await ai.run(q.id);
        if (rec.status === "done") return { sg: rec.result as PhotoSuggestion, why: "" };
        why = rec.error ?? "it failed";
      } catch (e) {
        why = (e as Error).message;
      }
    }
    console.warn(`telegram: local photo recognition unavailable: ${why}`);
    return { sg: null, why };
  }

  /** Ask the local vision model; if it's not there, offer Claude (with its price) or no AI. */
  private async recognise(s: Session) {
    const { ai, config, anthropic } = this.deps;
    const input = {
      images: s.photos.slice(0, MAX_PHOTOS_TO_AI).map((p) => p.file),
      ...(s.caption ? { caption: s.caption } : {}),
    };
    const { sg, why } = await this.localGuess(s.photos, s.caption);
    if (sg) return this.matched(s, sg);
    if (anthropic.configured) {
      try {
        const q = await ai.quote("photo-thing", input, "anthropic", config.ai.anthropicModel);
        s.status = "quote";
        s.quoteId = q.id;
        this.save(s);
        return this.renderQuote(s, q.estCostUsd, q.maxCostUsd, why);
      } catch (e) {
        console.warn(`telegram: no Claude quote: ${(e as Error).message}`);
      }
    }
    return this.matched(s, null);
  }

  private renderQuote(s: Session, est: number | null, max: number | null, why: string) {
    return this.editMenu(
      s,
      [
        "🤖 The local AI can't look at photos right now",
        `<i>${esc(why.slice(0, 160))}</i>`,
        "",
        `Ask Claude instead? About <b>${usd(est)}</b> (at most ${usd(max)}).`,
      ].join("\n"),
      [
        [{ text: `🤖 Ask Claude · ${usd(est)}`, callback_data: `${s.id}:c` }],
        [
          { text: "➕ Save without AI", callback_data: `${s.id}:s` },
          { text: "✖ Discard", callback_data: `${s.id}:x` },
        ],
      ],
    );
  }

  /** Things it could already be: by looks first, then by the AI's words; then show the menu. */
  private async matched(s: Session, suggestion: PhotoSuggestion | null) {
    s.suggestion = suggestion;
    s.candidates = await this.candidates(s, suggestion);
    s.status = "ready";
    this.save(s);
    await this.renderReady(s, true);
  }

  /** Up to 3 things the photos could be; `exclude` = things not to offer (a batch's own). */
  private async candidates(
    s: Session,
    suggestion: PhotoSuggestion | null,
    exclude: Set<string> = new Set(),
  ): Promise<Session["candidates"]> {
    const out: Session["candidates"] = [];
    const add = (t: ThingView | null | undefined, c: Omit<Session["candidates"][number], "id">) => {
      if (t && this.isItem(t) && !exclude.has(t.id) && !out.some((x) => x.id === t.id))
        out.push({ id: t.id, ...c });
    };
    // An id in the caption ("B-0042") goes first.
    if (s.caption)
      for (const h of this.store.search(s.caption, 3)) if (h.score >= 1000) add(h.thing, { via: "id" });

    const looks = new Map<string, number>();
    try {
      for (const p of s.photos.slice(0, MAX_PHOTOS_TO_AI))
        for (const h of await this.deps.vision.similar(p.file, 8, exclude))
          looks.set(h.thingId, Math.max(h.score, looks.get(h.thingId) ?? 0));
    } catch (e) {
      console.warn(`telegram: visual search failed: ${(e as Error).message}`);
    }
    for (const [id, score] of [...looks].toSorted((a, b) => b[1] - a[1]))
      if (score >= LOOKS_MIN) add(this.store.get(id), { via: "looks", score });

    const words = [suggestion?.name, ...(suggestion?.lookFor ?? []), suggestion ? null : s.caption]
      .filter(Boolean)
      .join(" ");
    if (words)
      for (const h of this.store.search(words, SEARCH_POOL, { any: true })) {
        // A thing with pictures that looks nothing like the photo isn't it, whatever its name says.
        const score = looks.get(h.thing.id);
        if (this.coverFile(h.thing.id) && (score ?? 0) < LOOKS_MIN) continue;
        add(h.thing, { via: "name", ...(score !== undefined ? { score } : {}) });
      }
    const looksLike = out.filter((c) => c.via === "looks");
    const [a, b] = looksLike;
    if (a && (a.score ?? 0) >= LOOKS_SAME && (!b || (a.score ?? 0) - (b.score ?? 0) >= LOOKS_LEAD))
      a.sure = true;
    return out.slice(0, MAX_CANDIDATES);
  }

  // ------------------------------------------------------------ an album: one new thing per photo

  /**
   * Several photos at once (D-029): every photo becomes a new thing right away, no questions. Then,
   * one at a time, the local AI names it (violet, unconfirmed) and the look-alike search flags ones
   * you may already have. All of it is fixable from the batch message or the thing page.
   */
  private async newBatch(msgs: TgMessage[]) {
    const first = msgs[0]!;
    const chatId = first.chat.id;
    const caption = msgs.map((m) => m.caption?.trim()).find(Boolean) ?? null;
    const msg = await this.send(chatId, `📥 Adding ${msgs.length} things…`, {
      reply_to_message_id: first.message_id,
    });
    const b = this.insert(chatId, "batch", caption, msg.message_id);
    const items: Session[] = [];
    for (const m of msgs) {
      let photo: Photo;
      try {
        photo = await this.fetchPhoto(m);
      } catch (e) {
        console.warn(`telegram: skipped a photo: ${(e as Error).message}`);
        continue;
      }
      b.photos.push(photo);
      const c = this.insert(chatId, "added", caption, null);
      c.photos = [photo];
      // Nobody has said what it is yet: name and kind stay unchecked (AI) until the guess or you fill them.
      c.thingId = this.store.createThing({ name: PLACEHOLDER, source: "ai" }).id;
      c.assetIds = this.addPhotos(c, c.thingId);
      c.extra = { batchOf: b.id, pending: true };
      this.save(c);
      items.push(c);
    }
    b.extra = { items: items.map((c) => c.id) };
    if (!items.length) {
      b.status = "failed";
      b.error = "no pictures";
      this.save(b);
      return this.editMenu(b, "😕 Couldn't get the photos.", []);
    }
    this.save(b);
    await this.renderBatch(b);

    const own = new Set(items.map((c) => c.thingId!));
    let noAi: string | null = null;
    for (const item of items) {
      // One at a time: the local model is a shared GPU box.
      const { sg, why }: { sg: PhotoSuggestion | null; why: string } =
        noAi === null ? await this.localGuess(item.photos, caption) : { sg: null, why: noAi };
      if (!sg) noAi = why;
      const c = this.load(item.id)!; // you may have acted on it meanwhile
      if (sg && c.status === "added" && c.thingId) {
        const t = this.store.get(c.thingId);
        if (t && !t.archivedAt)
          applySuggestion(
            this.store,
            t.id,
            sg,
            new Set(["parent", ...(t.name !== PLACEHOLDER ? ["name"] : [])]),
          );
      }
      c.suggestion = sg;
      c.candidates = await this.candidates(c, sg, own);
      delete c.extra.pending;
      this.save(c);
      if (c.menuId) await this.renderAny(c);
      const cur = this.load(b.id)!;
      if (noAi && !cur.extra.noAi) {
        cur.extra.noAi = noAi;
        this.save(cur);
      }
      await this.renderBatch(cur);
    }
  }

  private items(b: Session): Session[] {
    return (b.extra.items ?? []).map((id) => this.load(id)).filter((c): c is Session => Boolean(c));
  }

  private async renderBatch(b: Session) {
    if (b.status !== "batch") return;
    const items = this.items(b);
    const pending = items.filter((c) => c.extra.pending).length;
    const added = items.filter((c) => c.status === "added").length;
    const lines = [
      `📥 <b>${added} new thing${added === 1 ? "" : "s"}</b>${pending ? ` · 🔍 looking at ${pending}…` : ""}`,
      "",
    ];
    items.forEach((c, i) => {
      const t = c.thingId ? this.store.get(c.thingId) : null;
      const n = `${i + 1}.`;
      if (c.status === "attached" && t) lines.push(`${n} 📎 photo added to your ${this.link(t)}`);
      else if (c.status !== "added" || !t || t.archivedAt) lines.push(`${n} <s>↩️ undone</s>`);
      else {
        const sure = this.sureMatch(c);
        lines.push(
          [
            `${n} ${c.extra.pending && t.name === PLACEHOLDER ? "🔍 …" : this.link(t)}`,
            c.extra.pending ? "" : esc(this.kindName(t.kind)),
            t.parentId ? `📍 ${esc(t.path.at(-1)?.name ?? "")}` : "",
            sure ? `🎯 looks like your ${this.link(sure)}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        );
      }
    });
    lines.push("");
    if (b.extra.noAi)
      lines.push(`🤖 No AI names: the local AI is away (<i>${esc(clip(b.extra.noAi, 100))}</i>).`);
    lines.push("Wrong guess? Reply to this message, e.g. “2 dog nail clipper”, or tap a number.");
    const kb: Keyboard = pairs(
      items.map((c, i) => {
        const t = c.thingId ? this.store.get(c.thingId) : null;
        const label =
          c.status === "added" && t && !t.archivedAt
            ? c.extra.pending && t.name === PLACEHOLDER
              ? "🔍"
              : clip(t.name, 18)
            : c.status === "attached"
              ? "📎"
              : "↩️";
        return { text: `${i + 1} · ${this.sureMatch(c) ? "🎯 " : ""}${label}`, callback_data: `${c.id}:o` };
      }),
    );
    if (added) kb.push([{ text: "📍 All in…", callback_data: `${b.id}:P` }]);
    kb.push([
      { text: "🔗 It's all one thing", callback_data: `${b.id}:1` },
      { text: "↩️ Undo all", callback_data: `${b.id}:U` },
    ]);
    await this.editMenu(b, lines.join("\n"), kb);
  }

  /** A batch photo that clearly looks like a thing you have. */
  private sureMatch(c: Session): ThingView | null {
    const top = c.status === "added" ? c.candidates[0] : undefined;
    const t = top && (top.sure || top.via === "id") ? this.store.get(top.id) : null;
    return t && !t.archivedAt ? t : null;
  }

  /** "2 dog nail clipper" in reply to the batch message renames the second one. */
  private async onBatchReply(b: Session, text: string) {
    const m = /^#?(\d+)[\s.:)–-]+(.+)$/s.exec(text);
    const c = m ? this.items(b)[Number(m[1]) - 1] : undefined;
    if (!m || !c) return this.send(b.chatId, "Reply with a number and a name, e.g. “2 dog nail clipper”.");
    if (c.status !== "added" || !c.thingId) return this.send(b.chatId, `${m[1]} isn't a new thing any more.`);
    await this.rename(c, m[2]!.trim());
    await this.renderBatch(b);
  }

  /** Undo every photo of a batch. */
  private undoBatch(b: Session) {
    for (const c of this.items(b)) {
      if (c.status === "added" && c.thingId && !this.store.get(c.thingId)?.archivedAt)
        this.store.archive(c.thingId);
      if (c.status === "attached")
        for (const id of c.assetIds) if (!this.store.asset(id)?.removedAt) this.store.removeAsset(id);
      c.status = "discarded";
      c.thingId = null;
      c.assetIds = [];
      delete c.extra.pending;
      this.save(c);
    }
  }

  /**
   * You named it: your name wins, and the AI's other unchecked guesses (made for what it *thought*
   * it was) are redone for your name, or dropped when the local AI is away.
   */
  private async rename(s: Session, name: string) {
    const id = s.thingId!;
    this.store.change(id, { name }, "you");
    const t = this.store.mustGet(id);
    const stale = Object.entries(t.meta)
      .filter(([k]) => !["name", "kind", "parent"].includes(k))
      .filter(([, m]) => m.source === "ai" && !m.confirmed)
      .map(([k]) => k.replace(/^data\./, ""))
      .filter((k) => t.data[k] !== undefined);
    const aiTags = t.tags.filter((x) => x.source === "ai");
    if (!stale.length && !aiTags.length && t.meta.kind?.source !== "ai")
      return this.renderAny(s, "✏️ Renamed");
    await this.renderAny(s, "✏️ Renamed · 🔍 redoing the details…");
    this.track(
      (async () => {
        const { sg } = await this.localGuess(s.photos, name);
        const cur = this.store.get(id);
        if (!cur || cur.archivedAt || cur.name !== name) return;
        if (stale.length)
          this.store.change(id, { data: Object.fromEntries(stale.map((k) => [k, null])) }, "ai", "ai");
        for (const tag of aiTags) this.store.unrelate("tagged", id, tag.id, "ai");
        if (sg) applySuggestion(this.store, id, sg, new Set(["name", "parent"]));
        const fresh = this.load(s.id)!;
        if (sg) fresh.suggestion = { ...sg, name };
        this.save(fresh);
        await this.renderAny(fresh, sg ? "✏️ Renamed · details redone for the new name" : "✏️ Renamed");
        if (fresh.extra.batchOf) await this.renderBatch(this.load(fresh.extra.batchOf)!);
      })(),
    );
  }

  private async renderAny(s: Session, note?: string) {
    if (s.status === "batch") return this.renderBatch(s);
    if ((s.status === "added" || s.status === "attached") && s.thingId) return this.renderDone(s, note);
    if (s.status === "ready") return this.renderReady(s);
  }

  // ------------------------------------------------------------ menus

  private async renderReady(s: Session, fresh = false) {
    const sg = s.suggestion;
    const things = s.candidates
      .map((c) => ({ c, t: this.store.get(c.id) }))
      .filter((x) => x.t && !x.t.archivedAt);
    const lines: string[] = [];
    const sure = things[0] && (things[0].c.via === "id" || things[0].c.sure) ? things[0] : null;
    const mark = (c: Session["candidates"][number]) =>
      c.via === "id" ? "" : c.score !== undefined ? ` · ${Math.round(c.score * 100)}% alike` : " · same name";
    const newLine = sg
      ? `<b>${esc(sg.name)}</b> · ${esc(this.kindName(sg.kind))}`
      : s.caption
        ? `<b>${esc(s.caption)}</b>`
        : "a photo (no AI)";
    if (sure) {
      // It's (very likely) something we have: lead with it; the AI's idea is the fallback.
      lines.push(`🎯 <b>1.</b> Looks like your ${this.link(sure.t!)}${mark(sure.c)}`);
      lines.push(sure.t!.parentId ? `📍 ${esc(this.pathText(sure.t!))}` : "📍 Not in a place yet");
      if (things.length > 1) {
        lines.push("", "Or one of these?");
        things
          .slice(1)
          .forEach(({ c, t }, i) =>
            lines.push(`${i + 2}. ${this.link(t!)}${mark(c)}${this.where(t!, " — ")}`),
          );
      }
      lines.push("", `If it's new: ${newLine}`);
    } else {
      lines.push(`🆕 ${newLine}`);
      if (sg?.description) lines.push(esc(sg.description));
      if (things.length) {
        lines.push("", "<b>Already in Burrow?</b>");
        things.forEach(({ c, t }, i) =>
          lines.push(`${i + 1}. ${this.link(t!)}${mark(c)}${this.where(t!, " — ")}`),
        );
      }
    }
    const kb: Keyboard = things.map(({ t }, i) =>
      sure && i === 0
        ? [
            { text: "📎 Yes, add the photo", callback_data: `${s.id}:a:${t!.id}` },
            { text: "🔎 Show it", callback_data: `${s.id}:w:${t!.id}` },
          ]
        : [
            { text: `📎 It's ${i + 1}: add photo`, callback_data: `${s.id}:a:${t!.id}` },
            { text: `🔎 Show ${i + 1}`, callback_data: `${s.id}:w:${t!.id}` },
          ],
    );
    const name = sg?.name ?? s.caption;
    kb.push([{ text: name ? `➕ New: ${clip(name, 28)}` : "➕ New thing", callback_data: `${s.id}:n` }]);
    kb.push([
      { text: "✏️ New, I'll name it", callback_data: `${s.id}:N` },
      { text: "✖ Discard", callback_data: `${s.id}:x` },
    ]);
    const text = lines.join("\n");

    // With pictures of the candidates, the menu is one numbered contact sheet.
    const tiles = things.map(({ t }) => ({ file: this.coverFile(t!.id), label: t!.name }));
    if (fresh && tiles.some((x) => x.file) && !s.menuPhoto) {
      const sheet = await contactSheet(this.deps.media, tiles).catch(() => null);
      if (sheet) {
        const old = s.menuId;
        const msg = await this.api.sendPhoto(s.chatId, sheet, {
          caption: text.slice(0, 1024),
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: kb },
        });
        s.menuId = msg.message_id;
        s.menuPhoto = true;
        this.save(s);
        if (old) await this.api.call("deleteMessage", { chat_id: s.chatId, message_id: old }).catch(() => {});
        return;
      }
    }
    await this.editMenu(s, text, kb);
  }

  private async renderDone(s: Session, note?: string) {
    const t = this.store.get(s.thingId!);
    if (!t) return this.editMenu(s, "Gone.", []);
    const lines = [
      s.status === "added"
        ? `✅ Added ${this.link(t)} · ${esc(this.kindName(t.kind))}`
        : `📎 Photo added to ${this.link(t)}`,
      t.parentId ? `📍 ${esc(this.pathText(t))}` : "📍 Not in a place yet",
    ];
    if (s.extra.pending) lines.push("🔍 Still looking at it…");
    if (note) lines.push(note);
    const kb: Keyboard = [];
    // From a batch nobody chose "new": offer the look-alikes it may really be.
    const alike =
      s.status === "added" && s.extra.batchOf
        ? s.candidates
            .map((c) => this.store.get(c.id))
            .filter((x): x is ThingView => Boolean(x && !x.archivedAt))
        : [];
    if (alike.length) {
      lines.push("", "Already in Burrow?");
      alike.forEach((x, i) => lines.push(`${i + 1}. ${this.link(x)}${this.where(x, " — ")}`));
      for (const [i, x] of alike.entries())
        kb.push([{ text: `📎 It's ${i + 1}: ${clip(x.name, 24)}`, callback_data: `${s.id}:m:${x.id}` }]);
    }
    const guess = s.status === "added" && !t.parentId ? s.suggestion?.placeId : null;
    const guessT = guess ? this.store.get(guess) : null;
    kb.push([
      ...(guessT ? [{ text: `📍 ${clip(guessT.name, 22)}?`, callback_data: `${s.id}:p:${guessT.id}` }] : []),
      { text: t.parentId ? "📍 Move…" : "📍 Choose place…", callback_data: `${s.id}:P` },
    ]);
    const row: Keyboard[number] = [];
    if (s.status === "added") row.push({ text: "✏️ Rename", callback_data: `${s.id}:r` });
    if (s.status === "attached" && this.store.coverAsset(t.id)?.id !== s.assetIds[0])
      row.push({ text: "⭐ Make it the cover", callback_data: `${s.id}:v` });
    row.push({ text: "↩️ Undo", callback_data: `${s.id}:u` });
    kb.push(row);
    await this.editMenu(s, lines.join("\n"), kb);
  }

  // ------------------------------------------------------------ buttons

  private async onCallback(cb: TgCallback) {
    const chatId = cb.message?.chat.id;
    if (chatId === undefined || !this.lets(chatId, cb.from.id)) {
      await this.answer(cb, "Not allowed");
      return;
    }
    const [sid, action, arg] = (cb.data ?? "").split(":");
    const s = this.load(Number(sid));
    if (!s || s.chatId !== chatId) return this.answer(cb, "That one is gone");
    try {
      const reply = await this.act(s, action ?? "", arg, cb);
      await this.answer(cb, reply ?? undefined);
      if (action !== "o") await this.refreshBatch(s);
    } catch (e) {
      console.error("telegram: button failed:", e);
      await this.answer(cb, `😕 ${(e as Error).message}`.slice(0, 190), true);
    }
  }

  /** Returns an optional toast text. */
  private async act(
    s: Session,
    action: string,
    arg: string | undefined,
    cb: TgCallback,
  ): Promise<string | null> {
    const open = s.status === "ready";
    switch (action) {
      case "c": {
        // Claude: only from a quote the person just saw. Expired → show a fresh price instead.
        if (s.status !== "quote" || !s.quoteId) return "Already done";
        const rec = this.deps.ai.get(s.quoteId);
        if (!rec || rec.status !== "quoted" || Date.parse(rec.expiresAt) < Date.now()) {
          await this.recognise(s);
          return "The price was old: here is a fresh one";
        }
        s.status = "looking";
        this.save(s);
        await this.editMenu(s, "🤖 Asking Claude…", []);
        this.track(
          this.deps.ai
            .run(s.quoteId)
            .then((r) =>
              r.status === "done" ? this.matched(s, r.result as PhotoSuggestion) : this.matched(s, null),
            ),
        );
        return null;
      }
      case "s":
        if (s.status !== "quote") return "Already done";
        await this.matched(s, null);
        return null;
      case "n":
        if (!open) return "Already done";
        this.create(s);
        await this.renderDone(s);
        return "Added";
      case "N":
      case "r":
        if (action === "N" ? !open : s.status !== "added") return "Already done";
        await this.prompt(s, action === "N" ? "name" : "rename", "What's it called?");
        return null;
      case "a": {
        if (!open || !arg) return "Already done";
        this.attach(s, arg);
        await this.renderDone(s);
        return "Photo added";
      }
      case "w": {
        const t = arg ? this.store.get(arg) : null;
        if (!t) return "Not found";
        await this.sendCard(s.chatId, t, open ? s : null, cb.message?.message_id);
        return null;
      }
      case "x":
        if (!open && s.status !== "quote") return "Already done";
        s.status = "discarded";
        this.save(s);
        await this.editMenu(s, "✖ Discarded", []);
        return null;
      case "p":
      case "k": {
        if (!this.targets(s).length || !arg) return "Nothing to place";
        return this.place(s, arg, action === "k" ? s.extra.spot : undefined);
      }
      case "P":
        if (!this.targets(s).length) return "Nothing to place";
        await this.placePicker(s);
        return null;
      case "o": {
        // A batch photo's own menu, as a new message.
        if (s.status === "discarded") return "Undone";
        const m = await this.send(s.chatId, "…", { reply_to_message_id: cb.message?.message_id });
        s.menuId = m.message_id;
        s.menuPhoto = false;
        this.save(s);
        await this.renderAny(s);
        return null;
      }
      case "m": {
        // It wasn't new after all: the photo goes to the thing you have.
        if (s.status !== "added" || !s.thingId || !arg) return "Already done";
        this.store.archive(s.thingId);
        this.attach(s, arg);
        await this.renderDone(s);
        return "Photo added";
      }
      case "1": {
        if (s.status !== "batch") return "Already done";
        this.undoBatch(s);
        s.status = "looking";
        s.extra = {};
        this.save(s);
        await this.editMenu(s, "🔍 One thing, then. Looking…", []);
        this.track(this.recognise(s));
        return null;
      }
      case "U":
        if (s.status !== "batch") return "Already done";
        this.undoBatch(s);
        s.status = "discarded";
        this.save(s);
        await this.editMenu(s, "↩️ Undone: none of these were added.", []);
        return "Undone";
      case "v":
        if (s.status !== "attached" || !s.thingId || !s.assetIds[0]) return "Already done";
        this.store.setCover(s.thingId, s.assetIds[0]);
        await this.renderDone(s);
        return "Cover set";
      case "u":
        return this.undo(s);
      case "B":
        s.awaiting = null;
        s.promptId = null;
        delete s.extra.spot;
        delete s.extra.placeOptions;
        this.save(s);
        await this.renderAny(s);
        return null;
      default:
        return "?";
    }
  }

  private create(s: Session, name?: string) {
    const sg = s.suggestion;
    const t = this.store.createThing({
      name: name ?? sg?.name ?? s.caption ?? "Photo from Telegram",
      // A typed name is yours; everything else the AI filled in stays violet until confirmed.
      ...(sg ? { source: "ai" as const, ...(name ? { sources: { name: "you" as const } } : {}) } : {}),
    });
    // The place guess is offered as a button, not applied: a photo doesn't say where it was taken.
    if (sg) applySuggestion(this.store, t.id, sg, new Set(["parent", ...(name ? ["name"] : [])]));
    s.thingId = t.id;
    s.assetIds = this.addPhotos(s, t.id);
    s.status = "added";
    this.save(s);
  }

  private attach(s: Session, thingId: string) {
    this.store.mustGet(thingId);
    s.thingId = thingId;
    s.assetIds = this.addPhotos(s, thingId);
    s.status = "attached";
    this.save(s);
  }

  private addPhotos(s: Session, thingId: string): string[] {
    return s.photos.map(
      (p) =>
        this.store.addAsset(thingId, {
          role: "photo",
          file: p.file,
          mime: p.mime,
          bytes: p.bytes,
          ...(p.width ? { width: p.width } : {}),
          ...(p.height ? { height: p.height } : {}),
          ...(p.thumb ? { thumb: p.thumb } : {}),
          source: "you",
          data: { via: "telegram" },
        }).id,
    );
  }

  private async undo(s: Session): Promise<string> {
    if (s.status === "added" && s.thingId) {
      this.store.archive(s.thingId);
    } else if (s.status === "attached") {
      for (const id of s.assetIds) if (!this.store.asset(id)?.removedAt) this.store.removeAsset(id);
    } else return "Nothing to undo";
    s.status = "ready";
    s.thingId = null;
    s.assetIds = [];
    s.awaiting = null;
    this.save(s);
    await this.renderReady(s);
    return "Undone";
  }

  /** The things a place pick moves: the session's thing, or a batch's new things. */
  private targets(s: Session): string[] {
    if (s.status === "batch")
      return this.items(s)
        .filter((c) => c.status === "added" && c.thingId && !this.store.get(c.thingId)?.archivedAt)
        .map((c) => c.thingId!);
    return s.thingId ? [s.thingId] : [];
  }

  private place(s: Session, placeId: string, spot?: string): string {
    const p = this.store.mustGet(placeId);
    const ids = this.targets(s);
    for (const id of ids) this.store.move(id, placeId, undefined, undefined, spot ?? null);
    const recent = [placeId, ...this.recentPlaces().filter((x) => x !== placeId)].slice(0, 5);
    this.setState("recent_places", JSON.stringify(recent));
    delete s.extra.spot;
    delete s.extra.placeOptions;
    s.awaiting = null;
    s.promptId = null;
    this.save(s);
    void this.renderAny(s).then(() => this.refreshBatch(s));
    return ids.length > 1 ? `${ids.length} things in ${p.name}` : `In ${p.name}`;
  }

  private async refreshBatch(s: Session) {
    const b = s.extra.batchOf ? this.load(s.extra.batchOf) : null;
    if (b) await this.renderBatch(b);
  }

  /** A reply to the menu itself names a place: no extra "which place?" message (D-029). */
  private awaitPlace(s: Session) {
    s.awaiting = "place";
    s.promptId = s.menuId;
    this.save(s);
  }

  private async placePicker(s: Session) {
    const targets = this.targets(s);
    const t = this.store.mustGet(targets[0]!);
    const ids = [
      ...(s.suggestion?.placeId ? [s.suggestion.placeId] : []),
      ...this.recentPlaces(),
      ...this.store
        .placeTree()
        .places.filter((p) => !p.parentId)
        .map((p) => p.id),
    ];
    const opts = [...new Set(ids)]
      .filter((id) => !targets.includes(id) && id !== t.parentId)
      .map((id) => this.store.get(id))
      .filter((p): p is ThingView => Boolean(p && !p.archivedAt))
      .slice(0, 6);
    const what = targets.length > 1 ? `are these ${targets.length} things` : `is ${this.link(t)}`;
    await this.editMenu(
      s,
      `📍 Where ${what}?\nPick one, or reply to this message with a place, e.g. “IVAR shelf, shelf 3”.`,
      [
        ...pairs(opts.map((p) => ({ text: clip(p.name, 24), callback_data: `${s.id}:p:${p.id}` }))),
        [{ text: "‹ Back", callback_data: `${s.id}:B` }],
      ],
    );
    this.awaitPlace(s);
  }

  // ------------------------------------------------------------ replies to prompts

  private async prompt(s: Session, what: "name" | "rename", text: string) {
    const m = await this.send(s.chatId, text, {
      reply_markup: { force_reply: true, input_field_placeholder: "name" },
    });
    s.promptId = m.message_id;
    s.awaiting = what;
    this.save(s);
  }

  private async onAnswer(s: Session, text: string) {
    const what = s.awaiting;
    s.awaiting = null;
    s.promptId = null;
    this.save(s);
    if (!text) return;
    if (what === "name" && s.status === "ready") {
      this.create(s, text);
      return this.renderDone(s);
    }
    if (what === "rename" && s.thingId) {
      await this.rename(s, text);
      return this.refreshBatch(s);
    }
    if (what === "place" && this.targets(s).length) {
      const [name, ...rest] = text.split(",");
      const spot = rest.join(",").trim() || undefined;
      const places = this.store
        .search(name!.trim(), 20)
        .map((h) => h.thing)
        .filter((t) => this.store.kind(t.kind)?.isPlace && !this.targets(s).includes(t.id));
      const exact = places.filter((p) => p.name.toLowerCase() === name!.trim().toLowerCase());
      const pick = exact.length === 1 ? exact[0] : places.length === 1 ? places[0] : null;
      if (pick) {
        this.place(s, pick.id, spot);
        return;
      }
      this.awaitPlace(s);
      if (!places.length)
        return this.send(
          s.chatId,
          `No place called “${esc(name!.trim())}”. Reply to the menu with another name.`,
        );
      if (spot) s.extra.spot = spot;
      else delete s.extra.spot;
      this.save(s);
      return this.editMenu(s, `📍 Which one${spot ? ` (spot: ${esc(spot)})` : ""}?`, [
        ...places.slice(0, 6).map((p) => [
          {
            text: clip(`${p.name}${p.path.length ? ` · ${p.path.at(-1)!.name}` : ""}`, 40),
            callback_data: `${s.id}:k:${p.id}`,
          },
        ]),
        [{ text: "‹ Back", callback_data: `${s.id}:B` }],
      ]);
    }
  }

  // ------------------------------------------------------------ pieces

  /** A thing's card: its picture, where it is, a link. Optionally "add my photo" for a pending session. */
  private async sendCard(chatId: number, t: ThingView, s: Session | null, replyTo?: number) {
    const caption = [
      `${this.link(t)} · ${esc(this.kindName(t.kind))}`,
      t.parentId ? `📍 ${esc(this.pathText(t))}` : "📍 Not in a place yet",
      typeof t.data.description === "string" ? esc(clip(t.data.description, 300)) : "",
    ]
      .filter(Boolean)
      .join("\n");
    const kb: Keyboard = s ? [[{ text: "📎 Add my photo to this", callback_data: `${s.id}:a:${t.id}` }]] : [];
    const extra = {
      parse_mode: "HTML",
      ...(replyTo ? { reply_to_message_id: replyTo } : {}),
      ...(kb.length ? { reply_markup: { inline_keyboard: kb } } : {}),
    };
    const file = this.coverFile(t.id);
    if (file) {
      const jpg = await sharp(this.deps.media.path(file))
        .rotate()
        .resize(1280, 1280, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85 })
        .toBuffer()
        .catch(() => null);
      if (jpg) return this.api.sendPhoto(chatId, jpg, { caption, ...extra });
    }
    return this.api.call<TgMessage>("sendMessage", { chat_id: chatId, text: caption, ...extra });
  }

  private send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.api.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  private async editMenu(s: Session, text: string, kb: Keyboard) {
    if (!s.menuId) return;
    const common = {
      chat_id: s.chatId,
      message_id: s.menuId,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: kb },
    };
    try {
      if (s.menuPhoto) await this.api.call("editMessageCaption", { ...common, caption: text.slice(0, 1024) });
      else
        await this.api.call("editMessageText", {
          ...common,
          text,
          link_preview_options: { is_disabled: true },
        });
    } catch (e) {
      if (!/not modified/.test((e as Error).message)) throw e;
    }
  }

  private answer(cb: TgCallback, text?: string, alert = false) {
    return this.api
      .call("answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text, show_alert: alert } : {}) })
      .catch(() => {});
  }

  private isItem(t: ThingView) {
    return !t.archivedAt && !this.store.kindIs(t.kind, "tag") && !this.store.kindIs(t.kind, "document");
  }

  private kindName(k: string) {
    return (
      this.store.kind(k)?.name ??
      this.store.kinds().find((x) => x.name.toLowerCase() === k.toLowerCase())?.name ??
      k
    );
  }

  private link(t: ThingView) {
    return `<a href="${this.deps.config.publicUrl}/t/${t.id}">${esc(t.name)}</a>`;
  }

  private pathText(t: ThingView) {
    const segs = t.path.map((p) => `${p.name}${p.position ? ` (${p.position})` : ""}`);
    return `${segs.join(" › ")}${t.position ? ` · ${t.position}` : ""}`;
  }

  private where(t: ThingView, sep: string) {
    return t.parentId ? `${sep}${esc(this.pathText(t))}` : "";
  }

  /** The cover's picture file (small one when there is), if it's a raster picture. */
  private coverFile(thingId: string): string | null {
    const a = this.store.coverAsset(thingId);
    if (!a || a.mime === "image/svg+xml") return a?.thumb ?? null;
    if (a.role === "model") return a.thumb ?? null;
    return a.thumb ?? (a.mime.startsWith("image/") ? a.file : null);
  }

  private recentPlaces(): string[] {
    try {
      return JSON.parse(this.getState("recent_places") ?? "[]") as string[];
    } catch {
      return [];
    }
  }

  getState(key: string): string | null {
    const r = this.store.db.prepare("select value from tg_state where key = ?").get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  setState(key: string, value: string) {
    this.store.db
      .prepare(
        "insert into tg_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
      )
      .run(key, value);
  }

  // ------------------------------------------------------------ session rows

  private load(id: number): Session | null {
    const r = this.store.db.prepare("select * from tg_sessions where id = ?").get(id) as Row | undefined;
    return r ? toSession(r) : null;
  }

  private insert(chatId: number, status: Status, caption: string | null, menuId: number | null): Session {
    const now = new Date().toISOString();
    const r = this.store.db
      .prepare(
        `insert into tg_sessions (chat_id, created_at, updated_at, status, caption, menu_id)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(chatId, now, now, status, caption, menuId);
    return this.load(Number(r.lastInsertRowid))!;
  }

  private findBatch(chatId: number, menuId: number): Session | null {
    const r = this.store.db
      .prepare("select * from tg_sessions where chat_id = ? and menu_id = ? and status = 'batch'")
      .get(chatId, menuId) as Row | undefined;
    return r ? toSession(r) : null;
  }

  private findByPrompt(chatId: number, promptId: number): Session | null {
    const r = this.store.db
      .prepare("select * from tg_sessions where chat_id = ? and prompt_id = ? and awaiting is not null")
      .get(chatId, promptId) as Row | undefined;
    return r ? toSession(r) : null;
  }

  private save(s: Session) {
    this.store.db
      .prepare(
        `update tg_sessions set updated_at = ?, status = ?, photos = ?, suggestion = ?, candidates = ?, thing_id = ?,
           asset_ids = ?, quote_id = ?, menu_id = ?, menu_photo = ?, prompt_id = ?, awaiting = ?, extra = ?, error = ?
         where id = ?`,
      )
      .run(
        new Date().toISOString(),
        s.status,
        JSON.stringify(s.photos),
        s.suggestion ? JSON.stringify(s.suggestion) : null,
        JSON.stringify(s.candidates),
        s.thingId,
        JSON.stringify(s.assetIds),
        s.quoteId,
        s.menuId,
        s.menuPhoto ? 1 : 0,
        s.promptId,
        s.awaiting,
        JSON.stringify(s.extra),
        s.error,
        s.id,
      );
  }
}

type Row = Record<string, string | number | null>;

function toSession(r: Row): Session {
  return {
    id: Number(r.id),
    chatId: Number(r.chat_id),
    status: r.status as Status,
    photos: JSON.parse(String(r.photos)) as Photo[],
    caption: (r.caption as string | null) ?? null,
    suggestion: r.suggestion ? (JSON.parse(String(r.suggestion)) as PhotoSuggestion) : null,
    candidates: JSON.parse(String(r.candidates)) as Session["candidates"],
    thingId: (r.thing_id as string | null) ?? null,
    assetIds: JSON.parse(String(r.asset_ids)) as string[],
    quoteId: (r.quote_id as string | null) ?? null,
    menuId: r.menu_id === null ? null : Number(r.menu_id),
    menuPhoto: Number(r.menu_photo) === 1,
    promptId: r.prompt_id === null ? null : Number(r.prompt_id),
    awaiting: (r.awaiting as Session["awaiting"]) ?? null,
    extra: JSON.parse(String(r.extra)) as Session["extra"],
    error: (r.error as string | null) ?? null,
  };
}

function isImage(m: TgMessage) {
  return Boolean(m.photo?.length || m.document?.mime_type?.startsWith("image/"));
}

function usd(v: number | null) {
  if (v === null) return "?";
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`;
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function pairs<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += 2) out.push(xs.slice(i, i + 2));
  return out;
}

/** Numbered tiles of the candidates' pictures, one image for the menu. */
export async function contactSheet(
  media: { path(file: string): string },
  tiles: { file: string | null; label: string }[],
): Promise<Buffer> {
  const T = 360;
  const G = 12;
  const cols = tiles.length === 4 ? 2 : tiles.length;
  const rows = Math.ceil(tiles.length / cols);
  const W = cols * T + (cols + 1) * G;
  const H = rows * T + (rows + 1) * G;
  const layers = await Promise.all(
    tiles.map(async (tile, i) => {
      const left = G + (i % cols) * (T + G);
      const top = G + Math.floor(i / cols) * (T + G);
      const img = tile.file
        ? await sharp(media.path(tile.file))
            .rotate()
            .resize(T, T, { fit: "contain", background: "#ffffff" })
            .flatten({ background: "#ffffff" })
            .png()
            .toBuffer()
            .catch(() => null)
        : null;
      const label = esc(clip(tile.label, 26)).replace(/"/g, "&quot;");
      const placeholder = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${T}" height="${T}"><rect width="100%" height="100%" fill="#e7e2d6"/><text x="50%" y="52%" font-family="sans-serif" font-size="24" fill="#5c574d" text-anchor="middle">${label}</text></svg>`,
      );
      const badge = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#1c1b19"/><text x="32" y="44" font-family="sans-serif" font-size="34" font-weight="bold" fill="#fff" text-anchor="middle">${i + 1}</text></svg>`,
      );
      return [
        { input: img ?? placeholder, left, top },
        { input: badge, left: left + 8, top: top + 8 },
      ];
    }),
  );
  return sharp({ create: { width: W, height: H, channels: 3, background: "#f4f1ea" } })
    .composite(layers.flat())
    .jpeg({ quality: 85 })
    .toBuffer();
}

const HELP = [
  "📷 <b>Send a photo of a thing.</b> I'll guess what it is and check whether it's already in Burrow.",
  "Then: ➕ add it as a new thing, 📎 add the photo to the one you have, or 🔎 see where that one lives.",
  "",
  "• Several photos at once = several things: each becomes a new thing, named by the AI. Fix any of them afterwards (reply “2 dog nail clipper”), or tap 🔗 if they were all one thing.",
  "• A caption helps: a name, or an id like B-0042.",
  "• Text without a photo searches: “glue gun” → where it is.",
  "• /me: which Burrow account you are here.",
  "",
  "Photos are recognised by the local AI. Claude is only used if you tap a button that shows its price.",
].join("\n");

/** Long-poll Telegram until stopped. Only one process may poll a bot token at a time. */
export function startTelegramBot(deps: Deps, api: import("./api.ts").TelegramApi) {
  const bot = new PhotoBot(deps, api);
  const state = { stopped: false };
  // Look at every existing picture once in the background, so the first photo isn't slow.
  const t0 = Date.now();
  void deps.vision
    .refresh()
    .then(
      (n) => n && console.log(`vision: indexed ${n} pictures in ${Math.round((Date.now() - t0) / 1000)}s`),
    )
    .catch((e: Error) => console.warn(`vision: ${e.message}`));
  let warned409 = false;
  // The bot's @username, for the account page's t.me links (D-033).
  void api
    .call<{ username?: string }>("getMe", {})
    .then((me) => {
      deps.telegram.username = me.username ?? null;
    })
    .catch((e: Error) => console.warn(`telegram: getMe failed: ${e.message}`));
  void api
    .call("setMyCommands", {
      commands: [
        { command: "find", description: "Where is something?" },
        { command: "help", description: "How this works" },
      ],
    })
    .catch(() => {});
  const loop = async () => {
    let offset = Number(bot.getState("offset") ?? 0);
    while (!state.stopped) {
      try {
        const updates = await api.getUpdates(offset);
        warned409 = false;
        for (const u of updates) {
          offset = u.update_id + 1;
          bot.setState("offset", String(offset));
          await bot.handle(u).catch((e: Error) => console.error("telegram: update failed:", e));
        }
      } catch (e) {
        const code = (e as { code?: number }).code;
        if (code === 409 && !warned409) {
          warned409 = true;
          console.warn("telegram: another Burrow is polling this bot token (set TG_BOT=0 on one of them)");
        } else if (code !== 409) console.warn(`telegram: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, code === 409 ? 30_000 : 5000));
      }
    }
  };
  void loop();
  return {
    bot,
    stop() {
      state.stopped = true;
    },
  };
}
