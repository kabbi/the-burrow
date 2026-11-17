import { randomBytes } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { BurrowError } from "@burrow/core";
import type { Deps } from "../app.ts";
import { SESSION_DAYS, type Account } from "../auth/accounts.ts";
import { runAs } from "../auth/context.ts";

// Sign-in for the web app (D-032): username + password, or a passkey. A session is an HttpOnly
// cookie whose secret is stored hashed. No access control yet: every account may do everything;
// what accounts buy us is attribution (each event's actor is the username) and a locked door.

export const COOKIE = "burrow_session";

/** Paths under /api that work without signing in. */
const OPEN = new Set([
  "/health",
  "/auth/state",
  "/auth/setup",
  "/auth/login",
  "/auth/logout",
  "/auth/passkey/options",
  "/auth/passkey/login",
  // The bookmarklet form-POSTs from the shop's page: a SameSite=Lax cookie isn't sent there. It
  // only parks a page preview in memory and redirects to Add, which needs a session (D-024).
  "/capture",
]);

export function readCookie(req: Request, name: string): string | null {
  return cookieFrom(req.get("cookie"), name);
}

/** One cookie from a Cookie header (also for WebSocket upgrades, which aren't Express requests). */
export function cookieFrom(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSession(req: Request, res: Response, secret: string | null) {
  res.cookie(COOKIE, secret ?? "", {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    path: "/",
    maxAge: secret ? SESSION_DAYS * 86_400_000 : 0,
  });
}

/** The account signed in on this request, if any (set by `requireAccount`). */
export const accountOf = (res: Response): Account | null =>
  (res.locals.account as Account | undefined) ?? null;
const me = (res: Response): Account => {
  const a = accountOf(res);
  if (!a) throw new BurrowError("Sign in first", 401);
  return a;
};

/**
 * Guards /api and /media. Writes from another origin are refused outright (SameSite=Lax still lets
 * sibling subdomains through). With auth off (tests, BURROW_AUTH=0) everything acts as "you".
 */
export function requireAccount({ accounts, config }: Deps): RequestHandler {
  return (req, res, next) => {
    const origin = req.get("origin");
    if (req.method !== "GET" && req.method !== "HEAD" && origin && req.path !== "/capture") {
      let host = "";
      try {
        host = new URL(origin).host;
      } catch {}
      if (host !== req.get("host"))
        return void res.status(403).json({ error: "Cross-origin request refused" });
    }
    if (!config.auth) return next();
    const secret = readCookie(req, COOKIE);
    const account = secret ? accounts.session(secret) : null;
    if (account) {
      res.locals.account = account;
      return runAs(account.username, next);
    }
    if (OPEN.has(req.path)) return next();
    res.status(401).json({ error: "Sign in first", signIn: true });
  };
}

/** Wrong passwords slow down per username: 5 free tries, then a doubling wait up to 15 minutes. */
class Throttle {
  private fails = new Map<string, { n: number; until: number }>();
  check(key: string) {
    const f = this.fails.get(key);
    if (f && f.until > Date.now())
      throw new BurrowError(`Too many tries. Wait ${Math.ceil((f.until - Date.now()) / 1000)} s.`, 429);
  }
  fail(key: string) {
    const n = (this.fails.get(key)?.n ?? 0) + 1;
    const wait = n < 5 ? 0 : Math.min(15 * 60_000, 30_000 * 2 ** (n - 5));
    this.fails.set(key, { n, until: Date.now() + wait });
  }
  ok(key: string) {
    this.fails.delete(key);
  }
}

/** WebAuthn challenges, one use each, five minutes. */
interface Challenge {
  challenge: string;
  purpose: "login" | "register";
  username?: string;
  origin: string;
  expires: number;
}

/** The passkey relying party is whatever host the browser is on (burrow.example.com, localhost…). */
function relyingParty(req: Request) {
  const origin = req.get("origin");
  if (!origin) throw new BurrowError("Passkeys need the browser's Origin header");
  const url = new URL(origin);
  if (url.host !== req.get("host")) throw new BurrowError("Origin doesn't match this server", 403);
  return { origin: url.origin, rpID: url.hostname };
}

const Username = z.string().trim().toLowerCase().min(1).max(40);
const Password = z.string().min(1).max(200);

export function authRoutes(deps: Deps): Router {
  const { accounts, store, tokens, config } = deps;
  const r = Router();
  const throttle = new Throttle();
  const challenges = new Map<string, Challenge>();

  const remember = (c: Omit<Challenge, "expires">) => {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
    const id = randomBytes(12).toString("base64url");
    challenges.set(id, { ...c, expires: now + 5 * 60_000 });
    return id;
  };
  const takeChallenge = (id: string, purpose: Challenge["purpose"]) => {
    const c = challenges.get(id);
    challenges.delete(id);
    if (!c || c.purpose !== purpose || c.expires < Date.now())
      throw new BurrowError("That passkey prompt expired. Try again.");
    return c;
  };

  const signIn = (req: Request, res: Response, a: Account) => {
    setSession(req, res, accounts.startSession(a.username, req.get("user-agent")));
    res.json({ me: meView(a) });
  };

  const meView = (a: Account) => ({
    ...a,
    telegramBot: deps.telegram.username,
    passkeys: accounts.passkeys(a.username),
    sessions: accounts.sessionCount(a.username),
  });

  // ---------------------------------------------------------- signing in

  r.get("/auth/state", (_req, res) => {
    const a = accountOf(res);
    res.json({
      auth: config.auth,
      needsSetup: config.auth && accounts.count() === 0,
      me: a ? meView(a) : null,
    });
  });

  /** The very first account, from the browser. Only while there are none (then: the CLI or Accounts page). */
  r.post("/auth/setup", async (req, res) => {
    const b = z
      .object({ username: Username, name: z.string().trim().max(100), password: Password })
      .parse(req.body);
    if (accounts.count() > 0) throw new BurrowError("Burrow already has accounts: sign in instead", 409);
    const a = await accounts.create(b);
    signIn(req, res, a);
  });

  r.post("/auth/login", async (req, res) => {
    const b = z.object({ username: Username, password: Password }).parse(req.body);
    throttle.check(b.username);
    const a = await accounts.verifyPassword(b.username, b.password);
    if (!a) {
      throttle.fail(b.username);
      throw new BurrowError("Wrong username or password", 401);
    }
    throttle.ok(b.username);
    signIn(req, res, a);
  });

  r.post("/auth/logout", (req, res) => {
    const secret = readCookie(req, COOKIE);
    if (secret) accounts.endSession(secret);
    setSession(req, res, null);
    res.json({ ok: true });
  });

  /** Passkey sign-in, step 1: a challenge for any passkey this site has (discoverable credentials). */
  r.post("/auth/passkey/options", async (req, res) => {
    const rp = relyingParty(req);
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required" });
    res.json({ challengeId: remember({ challenge: options.challenge, purpose: "login", ...rp }), options });
  });

  /** Step 2: the browser's signed answer. */
  r.post("/auth/passkey/login", async (req, res) => {
    const b = z
      .object({ challengeId: z.string(), response: z.record(z.string(), z.unknown()) })
      .parse(req.body);
    const c = takeChallenge(b.challengeId, "login");
    const response = b.response as unknown as AuthenticationResponseJSON;
    const pk = accounts.passkey(String(response.id));
    if (!pk) throw new BurrowError("Burrow doesn't know this passkey (removed?)", 401);
    const a = accounts.get(pk.username);
    if (!a || a.disabledAt) throw new BurrowError("That account is switched off", 401);
    const handle = response.response?.userHandle;
    if (handle && handle !== accounts.webauthnId(a.username))
      throw new BurrowError("This passkey belongs to someone else", 401);
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: c.origin,
      expectedRPID: new URL(c.origin).hostname,
      credential: {
        id: pk.id,
        publicKey: new Uint8Array(pk.publicKey),
        counter: pk.counter,
        transports: pk.transports,
      },
    }).catch((e: Error) => {
      throw new BurrowError(`Passkey not accepted: ${e.message}`, 401);
    });
    if (!v.verified) throw new BurrowError("Passkey not accepted", 401);
    accounts.usedPasskey(pk.id, v.authenticationInfo.newCounter);
    signIn(req, res, a);
  });

  // ---------------------------------------------------------- your account

  r.post("/account/password", async (req, res) => {
    const a = me(res);
    const b = z.object({ current: z.string().max(200).optional(), next: z.string() }).parse(req.body);
    if (a.hasPassword && !(await accounts.verifyPassword(a.username, b.current ?? "")))
      throw new BurrowError("The current password is wrong", 403);
    await accounts.setPassword(a.username, b.next);
    // Other devices signed in with the old password are signed out.
    accounts.endSessions(a.username, readCookie(req, COOKIE) ?? undefined);
    res.json({ me: meView(accounts.must(a.username)) });
  });

  r.patch("/account", (req, res) => {
    const a = me(res);
    // Linking needs a code sent from Telegram (proof it's yours, D-033); here you can only unlink.
    const b = z.object({ telegramId: z.null().optional() }).parse(req.body);
    if (b.telegramId === null) accounts.setTelegram(a.username, null);
    res.json({ me: meView(accounts.must(a.username)) });
  });

  /** A code to send the bot; the answer has a t.me link that sends it by itself. */
  r.post("/account/telegram/code", (_req, res) => {
    const a = me(res);
    const bot = deps.telegram.username;
    if (!bot) throw new BurrowError("The Telegram bot isn't running on this server", 409);
    const c = accounts.telegramCode(a.username);
    res.json({ ...c, bot, link: `https://t.me/${bot}?start=${c.code}` });
  });

  r.post("/account/sign-out-others", (req, res) => {
    const a = me(res);
    const n = accounts.endSessions(a.username, readCookie(req, COOKIE) ?? undefined);
    res.json({ ended: n, me: meView(accounts.must(a.username)) });
  });

  r.post("/account/passkeys/options", async (req, res) => {
    const a = me(res);
    const rp = relyingParty(req);
    const options = await generateRegistrationOptions({
      rpName: "Burrow",
      rpID: rp.rpID,
      userName: a.username,
      userDisplayName: a.name,
      userID: new Uint8Array(Buffer.from(accounts.webauthnId(a.username), "base64url")),
      attestationType: "none",
      excludeCredentials: accounts
        .storedPasskeys(a.username)
        .map((k) => ({ id: k.id, transports: k.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    res.json({
      challengeId: remember({
        challenge: options.challenge,
        purpose: "register",
        username: a.username,
        ...rp,
      }),
      options,
    });
  });

  r.post("/account/passkeys", async (req, res) => {
    const a = me(res);
    const b = z
      .object({
        challengeId: z.string(),
        response: z.record(z.string(), z.unknown()),
        label: z.string().max(80),
      })
      .parse(req.body);
    const c = takeChallenge(b.challengeId, "register");
    if (c.username !== a.username) throw new BurrowError("That prompt was for someone else", 403);
    const v = await verifyRegistrationResponse({
      response: b.response as unknown as RegistrationResponseJSON,
      expectedChallenge: c.challenge,
      expectedOrigin: c.origin,
      expectedRPID: new URL(c.origin).hostname,
    }).catch((e: Error) => {
      throw new BurrowError(`Passkey not saved: ${e.message}`);
    });
    if (!v.verified) throw new BurrowError("Passkey not saved");
    const cred = v.registrationInfo.credential;
    accounts.addPasskey(a.username, {
      id: cred.id,
      publicKey: cred.publicKey,
      counter: cred.counter,
      transports: cred.transports ?? [],
      label: b.label,
    });
    res.status(201).json({ me: meView(accounts.must(a.username)) });
  });

  r.delete("/account/passkeys/:id", (req, res) => {
    const a = me(res);
    accounts.removePasskey(a.username, req.params.id);
    res.json({ me: meView(accounts.must(a.username)) });
  });

  // ---------------------------------------------------------- everyone

  /**
   * Accounts and how to name every actor in history: people by their person thing, apps by their
   * token actor, "you" (before accounts) as the first account.
   */
  r.get("/accounts", (_req, res) => {
    const list = accounts.list();
    const owner = accounts.legacyOwner();
    res.json({
      accounts: list.map(({ username, personId, name, createdAt, disabledAt, telegramId }) => ({
        username,
        personId,
        name,
        createdAt,
        disabledAt,
        telegram: Boolean(telegramId),
      })),
      legacyOwner: owner?.username ?? null,
      apps: [...new Set(tokens.list().map((t) => t.actor))],
    });
  });

  /** Another person's account (no access control yet, D-032): any signed-in person may add one. */
  r.post("/accounts", async (req, res) => {
    const a = me(res);
    const b = z
      .object({
        username: Username,
        name: z.string().trim().max(100),
        password: z.string().min(1, "Give them a first password").max(200),
        personId: z.string().nullable().optional(),
      })
      .parse(req.body);
    const created = await accounts.create({
      ...b,
      personId: b.personId ? store.mustGet(b.personId).id : null,
      by: a.username,
    });
    res.status(201).json({ account: created });
  });

  return r;
}
