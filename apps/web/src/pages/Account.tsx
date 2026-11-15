import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { startRegistration } from "@simplewebauthn/browser";
import { del, get, patch, post, type ThingView } from "../lib/api.ts";
import { slug, useAccounts, useAuth, type AuthState, type Me } from "../lib/auth.ts";
import { timeAgo } from "../lib/hooks.ts";
import { useToast } from "../lib/toast.tsx";
import { PageHead, SecHead } from "../ui/parts.tsx";
import { passkeysWork } from "../components/SignIn.tsx";

// Your account and the household (D-032). No access control yet: everyone signed in may add people.

/** A guess at what to call this device's passkey. */
function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux PC";
  return "This device";
}

function useSetMe() {
  const qc = useQueryClient();
  return useCallback(
    (me: Me) => qc.setQueryData<AuthState>(["auth"], (old) => (old ? { ...old, me } : old)),
    [qc],
  );
}

export function Account() {
  const { data } = useAuth();
  const me = data?.me;
  const qc = useQueryClient();
  if (!data) return null;
  if (!me)
    return (
      <main className="page narrow">
        <PageHead title="Accounts" lede="Sign-in is switched off on this server (BURROW_AUTH=0)." />
      </main>
    );
  const signOut = async () => {
    await post("/auth/logout");
    qc.clear();
    qc.setQueryData<AuthState>(["auth"], { auth: true, needsSetup: false, me: null });
  };
  return (
    <main className="page narrow stack" style={{ gap: 20 }}>
      <PageHead
        title={me.name}
        lede={
          <>
            Signed in as <span className="mono">{me.username}</span>. Everything you change is recorded under
            your name. <Link to={`/t/${me.personId}`}>Your page</Link> lists what you own, bought or made.
          </>
        }
      >
        <button type="button" className="btn quiet" onClick={() => void signOut()}>
          Sign out
        </button>
      </PageHead>
      <div className="account-grid">
        <Passkeys me={me} />
        <Password me={me} />
        <Telegram me={me} />
        <Devices me={me} />
      </div>
      <People me={me} />
    </main>
  );
}

function Passkeys({ me }: { me: Me }) {
  const setMe = useSetMe();
  const toast = useToast();
  const [label, setLabel] = useState(deviceName);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      const { challengeId, options } = await post<{ challengeId: string; options: never }>(
        "/account/passkeys/options",
      );
      const response = await startRegistration({ optionsJSON: options });
      setMe((await post<{ me: Me }>("/account/passkeys", { challengeId, response, label })).me);
      toast({ text: `Passkey saved: ${label}` });
    } catch (e) {
      const err = e as Error;
      if (!/NotAllowed|abort|cancel/i.test(`${err.name} ${err.message}`)) setError(err.message);
    }
  };
  return (
    <section className="panel stack">
      <SecHead title="Passkeys" />
      <p className="muted small" style={{ margin: 0 }}>
        Sign in with your fingerprint, face or phone instead of the password.
      </p>
      {me.passkeys.length > 0 && (
        <div className="list">
          {me.passkeys.map((k) => (
            <div key={k.id} className="list-row">
              <span className="grow">
                <strong>{k.label}</strong>
                <br />
                <span className="muted small">
                  added {timeAgo(k.createdAt)} ·{" "}
                  {k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "not used yet"}
                </span>
              </span>
              <button
                type="button"
                className="btn small ghost"
                onClick={async () => {
                  if (!confirm(`Remove the passkey "${k.label}"? It stops working for Burrow.`)) return;
                  setMe((await del<{ me: Me }>(`/account/passkeys/${encodeURIComponent(k.id)}`)).me);
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      {passkeysWork() ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="field grow" style={{ minWidth: 160 }}>
            <span>Name it</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} required />
          </label>
          <button type="submit" className="btn main" style={{ alignSelf: "flex-end" }}>
            Add a passkey
          </button>
        </form>
      ) : (
        <p className="small" style={{ margin: 0 }}>
          Passkeys need a secure address: open Burrow at its https address (or on localhost) to add one.
        </p>
      )}
      {error && <p style={{ color: "var(--bad)", margin: 0 }}>{error}</p>}
    </section>
  );
}

function Password({ me }: { me: Me }) {
  const setMe = useSetMe();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="panel stack">
      <SecHead title="Password" />
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          post<{ me: Me }>("/account/password", { current, next })
            .then((r) => {
              setMe(r.me);
              setCurrent("");
              setNext("");
              toast({ text: "Password changed. Other devices were signed out." });
            })
            .catch((err: Error) => setError(err.message));
        }}
      >
        {/* Lets password managers file the change under the right account. */}
        <input type="text" hidden readOnly value={me.username} autoComplete="username" />
        {me.hasPassword && (
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
        )}
        <label className="field">
          <span>New password (8 characters or more)</span>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <button type="submit" className="btn" style={{ alignSelf: "flex-start" }}>
          Change password
        </button>
        {error && <p style={{ color: "var(--bad)", margin: 0 }}>{error}</p>}
      </form>
    </section>
  );
}

/**
 * Connect the Telegram bot with a one-time code (D-033): the t.me link sends "/start CODE" to the
 * bot, which links whoever sent it. The page checks every few seconds until it's done.
 */
function Telegram({ me }: { me: Me }) {
  const setMe = useSetMe();
  const toast = useToast();
  const [code, setCode] = useState<{ code: string; link: string; bot: string; expiresAt: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // Until the bot reports the link, check every few seconds (and drop an expired code).
  useEffect(() => {
    if (!code) return;
    const t = setInterval(async () => {
      if (Date.parse(code.expiresAt) < Date.now()) return setCode(null);
      const st = await get<AuthState>("/auth/state").catch(() => null);
      if (st?.me?.telegramId) {
        setMe(st.me);
        setCode(null);
        toast({ text: "Telegram connected" });
      }
    }, 3000);
    return () => clearInterval(t);
  }, [code, setMe, toast]);

  const start = () => {
    setError(null);
    post<{ code: string; link: string; bot: string; expiresAt: string }>("/account/telegram/code")
      .then(setCode)
      .catch((err: Error) => setError(err.message));
  };
  return (
    <section className="panel stack">
      <SecHead title="Telegram" />
      {me.telegramId ? (
        <>
          <p style={{ margin: 0 }}>
            Connected
            {me.telegramBot && (
              <>
                {" "}
                to <a href={`https://t.me/${me.telegramBot}`}>@{me.telegramBot}</a>
              </>
            )}
            . Photos you send the bot are recorded under your name.
          </p>
          <button
            type="button"
            className="btn ghost"
            style={{ alignSelf: "flex-start" }}
            onClick={() =>
              patch<{ me: Me }>("/account", { telegramId: null })
                .then((r) => setMe(r.me))
                .catch((err: Error) => setError(err.message))
            }
          >
            Disconnect
          </button>
        </>
      ) : !me.telegramBot ? (
        <p className="muted small" style={{ margin: 0 }}>
          The Telegram bot isn't running on this server (it needs <code className="mono">TG_BOT_TOKEN</code>).
        </p>
      ) : code ? (
        <>
          <p style={{ margin: 0 }}>Open the bot and press Start. That links this account.</p>
          <a
            className="btn"
            href={code.link}
            target="_blank"
            rel="noreferrer"
            style={{ alignSelf: "flex-start" }}
          >
            Open @{code.bot} in Telegram
          </a>
          <p className="muted small" style={{ margin: 0 }}>
            On another device? Send the bot <code className="mono">/link {code.code}</code>. The code works
            once, for 10 minutes. Waiting for Telegram…
          </p>
          <button
            type="button"
            className="btn ghost small"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setCode(null)}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            Send photos to <strong>@{me.telegramBot}</strong> to add things from your phone. Connect it to
            record them under your name.
          </p>
          <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={start}>
            Connect Telegram
          </button>
        </>
      )}
      {error && <p style={{ color: "var(--bad)", margin: 0 }}>{error}</p>}
    </section>
  );
}

function Devices({ me }: { me: Me }) {
  const setMe = useSetMe();
  const toast = useToast();
  return (
    <section className="panel stack">
      <SecHead title="Devices" />
      <p style={{ margin: 0 }}>
        Signed in on {me.sessions} {me.sessions === 1 ? "device" : "devices"}.
      </p>
      {me.sessions > 1 && (
        <button
          type="button"
          className="btn"
          style={{ alignSelf: "flex-start" }}
          onClick={async () => {
            const r = await post<{ ended: number; me: Me }>("/account/sign-out-others");
            setMe(r.me);
            toast({ text: `Signed out ${r.ended} other ${r.ended === 1 ? "device" : "devices"}` });
          }}
        >
          Sign out everywhere else
        </button>
      )}
    </section>
  );
}

/** Everyone in the household: accounts, and people Burrow knows who don't sign in. */
function People({ me }: { me: Me }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useAccounts();
  const persons = useQuery({
    queryKey: ["things", "person"],
    queryFn: () => get<{ things: ThingView[] }>("/things?kind=person&order=name&limit=500"),
  });
  const withAccount = new Set(data?.accounts.map((a) => a.personId));
  const others = (persons.data?.things ?? []).filter((p) => !withAccount.has(p.id));
  const [adding, setAdding] = useState<null | "account" | "person">(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [personId, setPersonId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setAdding(null);
    setName("");
    setUsername("");
    setPassword("");
    setPersonId("");
    setError(null);
  };
  const existing = others.find((p) => p.id === personId);
  const done = (msg: string) => {
    toast({ text: msg });
    reset();
    void qc.invalidateQueries();
  };

  return (
    <section className="panel stack">
      <SecHead title="People">
        <span className="muted small">things can be owned by, bought by or made by them</span>
      </SecHead>
      <div className="list">
        {data?.accounts.map((a) => (
          <div key={a.username} className="list-row">
            <span className="grow">
              <Link to={`/t/${a.personId}`}>
                <strong>{a.name}</strong>
              </Link>{" "}
              <span className="mono muted small">{a.username}</span>
              {a.username === me.username && (
                <span className="tag" style={{ marginLeft: 8 }}>
                  you
                </span>
              )}
            </span>
            <span className="muted small">
              {a.disabledAt ? "switched off" : `account since ${new Date(a.createdAt).toLocaleDateString()}`}
              {a.username === data.legacyOwner && " · made the changes from before accounts"}
            </span>
          </div>
        ))}
        {others.map((p) => (
          <div key={p.id} className="list-row">
            <span className="grow">
              <Link to={`/t/${p.id}`}>
                <strong>{p.name}</strong>
              </Link>
            </span>
            <span className="muted small">no account</span>
            <button
              type="button"
              className="btn small ghost"
              onClick={() => {
                reset();
                setAdding("account");
                setPersonId(p.id);
                setUsername(slug(p.name));
              }}
            >
              Give an account
            </button>
          </div>
        ))}
      </div>
      {!adding && (
        <div className="row">
          <button type="button" className="chip mini dashed" onClick={() => setAdding("account")}>
            + someone who signs in
          </button>
          <button type="button" className="chip mini dashed" onClick={() => setAdding("person")}>
            + someone who doesn't (a child, a guest, grandma)
          </button>
        </div>
      )}
      {adding && (
        <form
          className="row api-new"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (adding === "person")
              post("/things", { name, kind: "person" })
                .then(() => done(`Added ${name}`))
                .catch((err: Error) => setError(err.message));
            else
              post("/accounts", {
                name: existing?.name ?? name,
                username: username || slug(name),
                password,
                personId: existing?.id ?? null,
              })
                .then(() =>
                  done(`Account made for ${existing?.name ?? name}. Tell them their first password.`),
                )
                .catch((err: Error) => setError(err.message));
          }}
        >
          {existing ? (
            <span style={{ alignSelf: "center", flex: "1 1 160px" }}>
              <strong>{existing.name}</strong>
            </span>
          ) : (
            <label className="field" style={{ flex: "1 1 160px" }}>
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
            </label>
          )}
          {adding === "account" && (
            <>
              <label className="field" style={{ flex: "1 1 140px" }}>
                <span>Username</span>
                <input
                  className="mono"
                  value={username}
                  placeholder={slug(name) || "anna"}
                  onChange={(e) => setUsername(slug(e.target.value))}
                  autoCapitalize="none"
                  autoComplete="off"
                />
              </label>
              <label className="field" style={{ flex: "1 1 160px" }}>
                <span>First password</span>
                <input
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                  minLength={8}
                  required
                />
              </label>
            </>
          )}
          <button type="submit" className="btn main" style={{ alignSelf: "flex-end" }}>
            {adding === "account" ? "Make the account" : "Add"}
          </button>
          <button type="button" className="btn ghost" style={{ alignSelf: "flex-end" }} onClick={reset}>
            Cancel
          </button>
        </form>
      )}
      {error && <p style={{ color: "var(--bad)", margin: 0 }}>{error}</p>}
    </section>
  );
}
