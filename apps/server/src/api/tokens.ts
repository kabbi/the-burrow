import { createHash, randomBytes } from "node:crypto";
import { BurrowError, type Db, type Migration } from "@burrow/core";

// API tokens for outside systems (D-020). Only a hash is stored; the token itself is shown once.
// Each token acts as an actor: every event it causes is recorded under that name.

export const tokenMigrations: Migration[] = [
  {
    id: "api/001-tokens",
    sql: `create table api_tokens (
            id text primary key,
            name text not null,
            actor text not null,
            scopes text not null,
            hash text not null unique,
            hint text not null,
            created_at text not null,
            last_used_at text,
            revoked_at text
          );`,
  },
];

export const SCOPES = ["read", "write", "schema"] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_INFO: Record<Scope, string> = {
  read: "Read things, places, tags, assets, schema and history.",
  write: "Create and change things, tags, links, refs and assets; undo. Includes read.",
  schema: "Define kinds and link types. Includes read.",
};

/** Names people and Burrow itself already write under: an app can't pretend to be one of them. */
const RESERVED = new Set(["you", "ai", "burrow", "system", "import", "paperless", "homebox", "telegram"]);
export const ACTOR_RE = /^[a-z][a-z0-9-]{1,39}$/;

export interface ApiToken {
  id: string;
  name: string;
  /** Recorded as the actor of every event this token causes. */
  actor: string;
  scopes: Scope[];
  /** The last characters, to tell tokens apart. */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

type Row = Record<string, unknown>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const toToken = (r: Row): ApiToken => ({
  id: String(r.id),
  name: String(r.name),
  actor: String(r.actor),
  scopes: JSON.parse(String(r.scopes)) as Scope[],
  hint: String(r.hint),
  createdAt: String(r.created_at),
  lastUsedAt: (r.last_used_at as string | null) ?? null,
  revokedAt: (r.revoked_at as string | null) ?? null,
});

export class Tokens {
  private db: Db;
  private touched = new Map<string, number>();

  constructor(db: Db) {
    this.db = db;
  }

  create(input: { name: string; actor: string; scopes: Scope[] }): { token: string; info: ApiToken } {
    const name = input.name.trim();
    if (!name) throw new BurrowError("A token needs a name");
    if (!ACTOR_RE.test(input.actor))
      throw new BurrowError("Actor: 2–40 lowercase letters, digits and -, starting with a letter");
    if (RESERVED.has(input.actor)) throw new BurrowError(`"${input.actor}" is reserved for Burrow itself`);
    const scopes = [...new Set(input.scopes)].filter((s) => SCOPES.includes(s));
    if (!scopes.length) throw new BurrowError("Pick at least one scope");
    const token = `bur_${randomBytes(24).toString("base64url")}`;
    const id = `tok_${randomBytes(6).toString("hex")}`;
    this.db
      .prepare(
        `insert into api_tokens (id, name, actor, scopes, hash, hint, created_at) values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        input.actor,
        JSON.stringify(scopes),
        sha(token),
        token.slice(-4),
        new Date().toISOString(),
      );
    return { token, info: this.mustGet(id) };
  }

  list(): ApiToken[] {
    return (this.db.prepare("select * from api_tokens order by created_at desc").all() as Row[]).map(toToken);
  }

  get(id: string): ApiToken | null {
    const r = this.db.prepare("select * from api_tokens where id = ?").get(id) as Row | undefined;
    return r ? toToken(r) : null;
  }

  mustGet(id: string): ApiToken {
    const t = this.get(id);
    if (!t) throw new BurrowError(`No token ${id}`, 404);
    return t;
  }

  revoke(id: string): ApiToken {
    this.mustGet(id);
    this.db
      .prepare("update api_tokens set revoked_at = coalesce(revoked_at, ?) where id = ?")
      .run(new Date().toISOString(), id);
    return this.mustGet(id);
  }

  /** The live token behind a secret, or null. Notes the last use (at most once a minute). */
  verify(secret: string): ApiToken | null {
    if (!secret.startsWith("bur_")) return null;
    const r = this.db
      .prepare("select * from api_tokens where hash = ? and revoked_at is null")
      .get(sha(secret)) as Row | undefined;
    if (!r) return null;
    const t = toToken(r);
    const now = Date.now();
    if (now - (this.touched.get(t.id) ?? 0) > 60_000) {
      this.touched.set(t.id, now);
      this.db
        .prepare("update api_tokens set last_used_at = ? where id = ?")
        .run(new Date(now).toISOString(), t.id);
    }
    return t;
  }
}

export const allows = (t: ApiToken, need: Scope) =>
  t.scopes.includes(need) || (need === "read" && t.scopes.length > 0);
