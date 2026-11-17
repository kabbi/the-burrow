// The terminal app speaks the web app's own /api with the web app's own client and types
// (apps/web/src/lib/api.ts), signed in as a person with a session cookie (D-037).
import { apiConfig, ApiError, get } from "@burrow/web/src/lib/api.ts";
import { formatId, parseId } from "@burrow/core/ids";
import type { Conn } from "./config.ts";

export * from "@burrow/web/src/lib/api.ts";
export { eventLabel } from "@burrow/web/src/lib/events.ts";
export { ROLE_LABEL } from "@burrow/web/src/lib/roles.ts";
export { aiInput, isUrl, pageData } from "@burrow/web/src/lib/page.ts";
export type { SearchHit, ThingStatus, FieldMeta, FieldSource, AssetRef } from "@burrow/core/types";

const COOKIE = "burrow_session";
const UA = "burrow-tui";

export class SignedOut extends Error {}

export function connect(conn: Conn, onSignedOut: () => void = () => {}) {
  apiConfig.base = `${conn.url}/api`;
  apiConfig.headers = {
    "user-agent": UA,
    ...(conn.session ? { cookie: `${COOKIE}=${conn.session}` } : {}),
  };
  apiConfig.onSignedOut = onSignedOut;
}

export interface Me {
  username: string;
  name: string;
  personId: string;
}
export interface AuthState {
  auth: boolean;
  needsSetup: boolean;
  me: Me | null;
}

export const authState = () => get<AuthState>("/auth/state");

/** Sign in with a password; answers the session secret from the Set-Cookie header. */
export async function login(url: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ username, password }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`);
  for (const c of res.headers.getSetCookie()) {
    const m = new RegExp(`^${COOKIE}=([^;]+)`).exec(c);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  throw new Error("The server didn't start a session");
}

/** "b42", "42", "B-0042" → "B-0042"; anything else → null. */
export function asId(s: string): string | null {
  const n = parseId(s);
  return n === null ? null : formatId(n);
}
