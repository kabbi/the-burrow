// A minimal Telegram Bot API client (fetch + long polling). Only what the photo bot needs.

export interface TgUser {
  id: number;
  first_name?: string;
}
export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}
export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  date: number;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
  media_group_id?: string;
  reply_to_message?: TgMessage;
}
export interface TgCallback {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

export interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}
export type Keyboard = Button[][];

/** What the bot calls; a fake implements it in tests. */
export interface BotApi {
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
  sendPhoto(chatId: number, photo: Buffer, params: Record<string, unknown>): Promise<TgMessage>;
  download(fileId: string): Promise<Buffer>;
}

export class TelegramError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export class TelegramApi implements BotApi {
  private base: string;
  private fileBase: string;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    const r = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return unwrap<T>(r, method);
  }

  async sendPhoto(chatId: number, photo: Buffer, params: Record<string, unknown>): Promise<TgMessage> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    for (const [k, v] of Object.entries(params))
      if (v !== undefined) form.set(k, typeof v === "string" ? v : JSON.stringify(v));
    form.set("photo", new Blob([new Uint8Array(photo)], { type: "image/jpeg" }), "photo.jpg");
    const r = await fetch(`${this.base}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    return unwrap<TgMessage>(r, "sendPhoto");
  }

  async download(fileId: string): Promise<Buffer> {
    const f = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!f.file_path)
      throw new Error("Telegram gave no file path (files over 20 MB can't be downloaded by bots)");
    const r = await fetch(`${this.fileBase}/${f.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`Telegram file download HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  /** Long poll; resolves with the next batch (possibly empty). */
  getUpdates(offset: number, timeoutS = 50): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutS, allowed_updates: ["message", "callback_query"] },
      (timeoutS + 15) * 1000,
    );
  }
}

async function unwrap<T>(r: Response, method: string): Promise<T> {
  const j = (await r.json().catch(() => null)) as {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
  } | null;
  if (!j?.ok)
    throw new TelegramError(j?.error_code ?? r.status, `${method}: ${j?.description ?? `HTTP ${r.status}`}`);
  return j.result as T;
}

/** HTML-escape for parse_mode HTML. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
