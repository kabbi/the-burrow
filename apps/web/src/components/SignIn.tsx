import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { startAuthentication } from "@simplewebauthn/browser";
import { post, SIGNED_OUT } from "../lib/api.ts";
import { slug, useAuth, type AuthState, type Me } from "../lib/auth.ts";
import { Mark } from "../ui/Icon.tsx";

/** Passkeys need a secure context (https or localhost) and a browser that has them. */
export const passkeysWork = () => window.isSecureContext && "PublicKeyCredential" in window;

/**
 * Nothing of Burrow shows until someone is signed in (D-032). The first visit makes the first
 * account; afterwards: password or passkey. A 401 anywhere brings this screen back.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isPending, error, refetch } = useAuth();
  useEffect(() => {
    const onOut = () => void qc.invalidateQueries({ queryKey: ["auth"] });
    window.addEventListener(SIGNED_OUT, onOut);
    return () => window.removeEventListener(SIGNED_OUT, onOut);
  }, [qc]);

  if (isPending) return null;
  if (error || !data)
    return (
      <Door title="Burrow can't be reached">
        <p className="muted">The server didn't answer. Is it running?</p>
        <button type="button" className="btn" onClick={() => void refetch()}>
          Try again
        </button>
      </Door>
    );
  if (data.needsSetup) return <Setup />;
  if (data.auth && !data.me) return <SignIn />;
  return children;
}

/** After signing in: forget everything fetched while signed out, then show the app. */
function useSignedIn() {
  const qc = useQueryClient();
  return (me: Me) => {
    qc.setQueryData<AuthState>(["auth"], (old) => ({ ...old, auth: true, needsSetup: false, me }));
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
  };
}

function Door({ title, lede, children }: { title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <main className="door">
      <div className="door-card panel stack">
        <span className="brand">
          <Mark />
          Burrow
        </span>
        <h1>{title}</h1>
        {lede && (
          <p className="muted" style={{ margin: 0 }}>
            {lede}
          </p>
        )}
        {children}
      </div>
    </main>
  );
}

function SignIn() {
  const signedIn = useSignedIn();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<{ me: Me }>) => {
    setBusy(true);
    setError(null);
    try {
      signedIn((await fn()).me);
    } catch (e) {
      const msg = (e as Error).message;
      // The person closed the passkey prompt: not an error worth shouting about.
      if (!/NotAllowed|abort|cancel/i.test(`${(e as Error).name} ${msg}`)) setError(msg);
    } finally {
      setBusy(false);
    }
  };
  const withPassword = () => run(() => post<{ me: Me }>("/auth/login", { username, password }));
  const withPasskey = () =>
    run(async () => {
      const { challengeId, options } = await post<{ challengeId: string; options: never }>(
        "/auth/passkey/options",
      );
      const response = await startAuthentication({ optionsJSON: options });
      return post<{ me: Me }>("/auth/passkey/login", { challengeId, response });
    });

  return (
    <Door title="Sign in">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void withPassword();
        }}
      >
        <label className="field">
          <span>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit" className="btn main big" disabled={busy}>
          Sign in
        </button>
      </form>
      {passkeysWork() && (
        <button type="button" className="btn big" disabled={busy} onClick={() => void withPasskey()}>
          Sign in with a passkey
        </button>
      )}
      {error && (
        <p role="alert" style={{ color: "var(--bad)", margin: 0 }}>
          {error}
        </p>
      )}
      <p className="muted small" style={{ margin: 0 }}>
        Forgot it? On the server: <code className="mono">pnpm prod:account passwd &lt;username&gt;</code>
      </p>
    </Door>
  );
}

function Setup() {
  const signedIn = useSignedIn();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Door
      title="Make the first account"
      lede="Burrow now knows who did what. This account is yours; changes made before today are shown as yours too. Add the rest of the household afterwards."
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          post<{ me: Me }>("/auth/setup", { name, username: username || slug(name), password })
            .then((r) => signedIn(r.me))
            .catch((err: Error) => setError(err.message));
        }}
      >
        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span>Username (to sign in; shown in history)</span>
          <input
            className="mono"
            value={username}
            placeholder={slug(name) || "dmitry"}
            onChange={(e) => setUsername(slug(e.target.value))}
            autoComplete="username"
            autoCapitalize="none"
          />
        </label>
        <label className="field">
          <span>Password (8 characters or more)</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <button type="submit" className="btn main big">
          Make my account
        </button>
        {error && (
          <p role="alert" style={{ color: "var(--bad)", margin: 0 }}>
            {error}
          </p>
        )}
      </form>
      <p className="muted small" style={{ margin: 0 }}>
        You can add a passkey on your account page once you're in.
      </p>
    </Door>
  );
}
