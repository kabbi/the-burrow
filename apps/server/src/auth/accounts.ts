import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { BurrowError, migrate, tx, type Db, type Migration, type Store } from "@burrow/core";

// Accounts (D-032): people who sign in. Each account points at a `person` thing in the graph, which
// carries the display name and the links (owns, bought, author of). Credentials live here, outside
// the event log: an append-only log (and the /db browser) is the wrong place for password hashes.

export const accountMigrations: Migration[] = [
  {
    id: "auth/001-accounts",
    sql: `
      create table accounts (
        username text primary key,
        person_id text not null unique,
        password text,
        webauthn_id text not null unique,
        telegram_id text unique,
        created_at text not null,
        disabled_at text
      );
      create table sessions (
        hash text primary key,
        username text not null references accounts(username),
        created_at text not null,
        seen_at text not null,
        expires_at text not null,
        user_agent text
      );
      create index sessions_user on sessions(username);
      create table passkeys (
        id text primary key,
        username text not null references accounts(username),
        public_key blob not null,
        counter integer not null default 0,
        transports text not null default '[]',
        label text not null,
        created_at text not null,
        last_used_at text
      );
      create index passkeys_user on passkeys(username);
    `,
  },
];

/** Names Burrow writes under itself, or wrote under before accounts: nobody can sign in as one. */
export const RESERVED_ACTORS = new Set([
  "you",
  "ai",
  "app",
  "burrow",
  "system",
  "import",
  "migration",
  "paperless",
  "homebox",
  "homebox-import",
  "homebox-sync",
  "pcbphoto-import",
  "telegram",
  "admin",
  "root",
]);
/** Usernames and app actors share one namespace: both end up in `events.actor`. */
export const ACTOR_RE = /^[a-z][a-z0-9-]{1,39}$/;

const hasTable = (db: Db, name: string) =>
  Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name));

/** Is this actor name taken by an account or an API token (or reserved)? */
export function actorTaken(db: Db, name: string): string | null {
  if (RESERVED_ACTORS.has(name)) return `"${name}" is reserved for Burrow itself`;
  if (hasTable(db, "accounts") && db.prepare("select 1 from accounts where username = ?").get(name))
    return `"${name}" is a person's username`;
  if (hasTable(db, "api_tokens") && db.prepare("select 1 from api_tokens where actor = ?").get(name))
    return `"${name}" is an app's actor name`;
  return null;
}

export interface Account {
  username: string;
  personId: string;
  /** The person thing's name. */
  name: string;
  hasPassword: boolean;
  telegramId: string | null;
  createdAt: string;
  disabledAt: string | null;
}

export interface Passkey {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface StoredPasskey extends Passkey {
  username: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
}

type Row = Record<string, unknown>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: object,
) => Promise<Buffer>;
// ~50 ms on the home server; 64 MiB of memory per hash.
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
export const SESSION_DAYS = 180;
const DAY = 86_400_000;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, key] = stored.split("$");
  if (algo !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64url");
  const got = await scrypt(pw, Buffer.from(salt, "base64url"), want.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(got, want);
}

export function checkNewPassword(pw: string) {
  if (pw.length < 8) throw new BurrowError("Use at least 8 characters for the password");
  if (pw.length > 200) throw new BurrowError("That password is too long");
}

export class Accounts {
  readonly db: Db;
  private store: Store;
  private now: () => Date;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.store = store;
    this.db = store.db;
    this.now = now;
    migrate(this.db, accountMigrations);
  }

  private toAccount = (r: Row): Account => ({
    username: String(r.username),
    personId: String(r.person_id),
    name: this.store.getRaw(String(r.person_id))?.name ?? String(r.username),
    hasPassword: r.password !== null,
    telegramId: (r.telegram_id as string | null) ?? null,
    createdAt: String(r.created_at),
    disabledAt: (r.disabled_at as string | null) ?? null,
  });

  count(): number {
    return Number((this.db.prepare("select count(*) n from accounts").get() as Row).n);
  }

  list(): Account[] {
    return (this.db.prepare("select * from accounts order by created_at").all() as Row[]).map(this.toAccount);
  }

  get(username: string): Account | null {
    const r = this.db.prepare("select * from accounts where username = ?").get(username) as Row | undefined;
    return r ? this.toAccount(r) : null;
  }

  must(username: string): Account {
    const a = this.get(username);
    if (!a) throw new BurrowError(`No account "${username}"`, 404);
    return a;
  }

  byTelegram(telegramId: string | number): Account | null {
    const r = this.db
      .prepare("select * from accounts where telegram_id = ? and disabled_at is null")
      .get(String(telegramId)) as Row | undefined;
    return r ? this.toAccount(r) : null;
  }

  /**
   * Who wrote the events from before accounts (actor "you"): the first account, i.e. whoever set
   * Burrow up. Display only; the log itself is never rewritten.
   */
  legacyOwner(): Account | null {
    const r = this.db.prepare("select * from accounts order by created_at, rowid limit 1").get() as
      | Row
      | undefined;
    return r ? this.toAccount(r) : null;
  }

  /**
   * Make an account. Without `personId` a new `person` thing is created for it (attributed to
   * `by`, or to the new account itself when it signs itself up).
   */
  async create(input: {
    username: string;
    name: string;
    password?: string | null;
    personId?: string | null;
    by?: string;
  }): Promise<Account> {
    const username = input.username.trim().toLowerCase();
    if (!ACTOR_RE.test(username))
      throw new BurrowError("Username: 2–40 characters, a–z, 0–9 and -, starting with a letter");
    const taken = actorTaken(this.db, username);
    if (taken) throw new BurrowError(taken, 409);
    if (input.password) checkNewPassword(input.password);
    const hash = input.password ? await hashPassword(input.password) : null;
    return tx(this.db, () => {
      let personId = input.personId ?? null;
      if (personId) {
        const p = this.store.mustGet(personId);
        if (!this.store.kindIs(p.kind, "person")) throw new BurrowError(`${p.id} isn't a person`);
        if (this.db.prepare("select 1 from accounts where person_id = ?").get(p.id))
          throw new BurrowError(`${p.name} already has an account`, 409);
        personId = p.id;
      } else {
        const name = input.name.trim() || username;
        personId = this.store.createThing({ name, kind: "person" }, input.by ?? username).id;
      }
      this.db
        .prepare(
          "insert into accounts (username, person_id, password, webauthn_id, created_at) values (?, ?, ?, ?, ?)",
        )
        .run(username, personId, hash, randomBytes(16).toString("base64url"), this.now().toISOString());
      return this.must(username);
    });
  }

  async setPassword(username: string, password: string) {
    checkNewPassword(password);
    this.must(username);
    const hash = await hashPassword(password);
    this.db.prepare("update accounts set password = ? where username = ?").run(hash, username);
  }

  /** The account if the password is right (and it's not disabled), else null. */
  async verifyPassword(username: string, password: string): Promise<Account | null> {
    const r = this.db
      .prepare("select * from accounts where username = ? and disabled_at is null")
      .get(username.trim().toLowerCase()) as Row | undefined;
    if (!r?.password) {
      // Same work either way, so timing doesn't tell which usernames exist.
      await checkPassword(password, DUMMY_HASH);
      return null;
    }
    return (await checkPassword(password, String(r.password))) ? this.toAccount(r) : null;
  }

  setTelegram(username: string, telegramId: string | null) {
    this.must(username);
    const id = telegramId?.trim() || null;
    if (id && !/^\d{1,20}$/.test(id)) throw new BurrowError("A Telegram user id is a number");
    const other = id ? this.byTelegram(id) : null;
    if (other && other.username !== username)
      throw new BurrowError(`That Telegram account is linked to ${other.username}`, 409);
    this.db.prepare("update accounts set telegram_id = ? where username = ?").run(id, username);
  }

  // Telegram link codes: shown on the account page, sent to the bot (/start CODE via a t.me
  // link, or /link CODE). In memory: the bot runs in this process, a code lives 10 minutes.
  private tgCodes = new Map<string, { username: string; expires: number }>();

  /** A fresh one-time code for linking Telegram; replaces this account's previous one. */
  telegramCode(username: string): { code: string; expiresAt: string } {
    this.must(username);
    const now = this.now().getTime();
    for (const [k, v] of this.tgCodes) if (v.expires < now || v.username === username) this.tgCodes.delete(k);
    // No 0/O/1/I: people may type it. 32^8 ≈ 10^12, and the bot slows down wrong guesses.
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = [...randomBytes(8)].map((b) => abc[b % 32]).join("");
    const expires = now + 10 * 60_000;
    this.tgCodes.set(code, { username, expires });
    return { code, expiresAt: new Date(expires).toISOString() };
  }

  /** Link the Telegram user who sent a valid code. Null if the code is unknown or expired. */
  redeemTelegramCode(code: string, telegramId: string | number): Account | null {
    const key = code.trim().toUpperCase();
    const c = this.tgCodes.get(key);
    if (!c || c.expires < this.now().getTime()) return null;
    this.tgCodes.delete(key);
    const a = this.get(c.username);
    if (!a || a.disabledAt) return null;
    // A Telegram user is one account: linking moves it away from whoever had it.
    this.db.prepare("update accounts set telegram_id = null where telegram_id = ?").run(String(telegramId));
    this.setTelegram(c.username, String(telegramId));
    return this.must(c.username);
  }

  setDisabled(username: string, disabled: boolean) {
    this.must(username);
    this.db
      .prepare("update accounts set disabled_at = ? where username = ?")
      .run(disabled ? this.now().toISOString() : null, username);
    if (disabled) this.endSessions(username);
  }

  webauthnId(username: string): string {
    return String(
      (this.db.prepare("select webauthn_id from accounts where username = ?").get(username) as Row)
        .webauthn_id,
    );
  }

  byWebauthnId(id: string): Account | null {
    const r = this.db
      .prepare("select * from accounts where webauthn_id = ? and disabled_at is null")
      .get(id) as Row | undefined;
    return r ? this.toAccount(r) : null;
  }

  // ------------------------------------------------------------ sessions

  /** A new session; returns the secret for the cookie (only its hash is kept). */
  startSession(username: string, userAgent?: string): string {
    const secret = randomBytes(32).toString("base64url");
    const now = this.now();
    this.db
      .prepare(
        "insert into sessions (hash, username, created_at, seen_at, expires_at, user_agent) values (?, ?, ?, ?, ?, ?)",
      )
      .run(
        sha(secret),
        username,
        now.toISOString(),
        now.toISOString(),
        new Date(now.getTime() + SESSION_DAYS * DAY).toISOString(),
        userAgent?.slice(0, 200) ?? null,
      );
    return secret;
  }

  /**
   * The signed-in account for a session secret. Sessions slide: use extends them, at most once an
   * hour (so reads don't write every time).
   */
  session(secret: string): Account | null {
    const hash = sha(secret);
    const r = this.db
      .prepare(
        `select a.*, s.seen_at, s.expires_at from sessions s join accounts a on a.username = s.username
         where s.hash = ? and a.disabled_at is null`,
      )
      .get(hash) as Row | undefined;
    if (!r) return null;
    const now = this.now();
    if (String(r.expires_at) <= now.toISOString()) {
      this.db.prepare("delete from sessions where hash = ?").run(hash);
      return null;
    }
    if (now.getTime() - Date.parse(String(r.seen_at)) > 3_600_000)
      this.db
        .prepare("update sessions set seen_at = ?, expires_at = ? where hash = ?")
        .run(now.toISOString(), new Date(now.getTime() + SESSION_DAYS * DAY).toISOString(), hash);
    return this.toAccount(r);
  }

  endSession(secret: string) {
    this.db.prepare("delete from sessions where hash = ?").run(sha(secret));
  }

  /** Sign out everywhere, optionally keeping one session (the current one). */
  endSessions(username: string, keepSecret?: string): number {
    const res = this.db
      .prepare("delete from sessions where username = ? and hash != ?")
      .run(username, keepSecret ? sha(keepSecret) : "");
    return Number(res.changes);
  }

  sessionCount(username: string): number {
    return Number(
      (
        this.db
          .prepare("select count(*) n from sessions where username = ? and expires_at > ?")
          .get(username, this.now().toISOString()) as Row
      ).n,
    );
  }

  // ------------------------------------------------------------ passkeys

  private toPasskey = (r: Row): StoredPasskey => ({
    id: String(r.id),
    username: String(r.username),
    label: String(r.label),
    publicKey: new Uint8Array(r.public_key as Uint8Array<ArrayBuffer>),
    counter: Number(r.counter),
    transports: JSON.parse(String(r.transports)) as string[],
    createdAt: String(r.created_at),
    lastUsedAt: (r.last_used_at as string | null) ?? null,
  });

  passkeys(username: string): Passkey[] {
    return (
      this.db.prepare("select * from passkeys where username = ? order by created_at").all(username) as Row[]
    ).map((r) => {
      const { id, label, createdAt, lastUsedAt } = this.toPasskey(r);
      return { id, label, createdAt, lastUsedAt };
    });
  }

  storedPasskeys(username: string): StoredPasskey[] {
    return (this.db.prepare("select * from passkeys where username = ?").all(username) as Row[]).map(
      this.toPasskey,
    );
  }

  passkey(id: string): StoredPasskey | null {
    const r = this.db.prepare("select * from passkeys where id = ?").get(id) as Row | undefined;
    return r ? this.toPasskey(r) : null;
  }

  addPasskey(
    username: string,
    p: { id: string; publicKey: Uint8Array; counter: number; transports: string[]; label: string },
  ): Passkey {
    if (this.passkey(p.id)) throw new BurrowError("That passkey is already registered", 409);
    this.db
      .prepare(
        "insert into passkeys (id, username, public_key, counter, transports, label, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        p.id,
        username,
        p.publicKey,
        p.counter,
        JSON.stringify(p.transports),
        p.label.trim().slice(0, 80) || "Passkey",
        this.now().toISOString(),
      );
    return this.passkeys(username).find((k) => k.id === p.id)!;
  }

  usedPasskey(id: string, counter: number) {
    this.db
      .prepare("update passkeys set counter = ?, last_used_at = ? where id = ?")
      .run(counter, this.now().toISOString(), id);
  }

  removePasskey(username: string, id: string) {
    const res = this.db.prepare("delete from passkeys where id = ? and username = ?").run(id, username);
    if (!res.changes) throw new BurrowError("No such passkey", 404);
  }
}

// A real scrypt hash of a random password, for constant-ish time on unknown usernames.
const DUMMY_HASH = await hashPassword(randomBytes(12).toString("base64url"));
