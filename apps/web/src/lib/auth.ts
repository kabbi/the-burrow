import { useQuery } from "@tanstack/react-query";
import { get } from "./api.ts";

// Accounts and sign-in (D-032).

/** A username from a name: "Anna Maria" → "anna-maria". */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

export interface Passkey {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Me {
  username: string;
  /** The person thing this account is. */
  personId: string;
  name: string;
  hasPassword: boolean;
  telegramId: string | null;
  /** The bot's @username when it runs on this server (null: no bot). */
  telegramBot: string | null;
  createdAt: string;
  passkeys: Passkey[];
  /** Devices signed in. */
  sessions: number;
}

export interface AuthState {
  /** false: sign-in is switched off on this server (BURROW_AUTH=0). */
  auth: boolean;
  needsSetup: boolean;
  me: Me | null;
}

export interface AccountRow {
  username: string;
  personId: string;
  name: string;
  createdAt: string;
  disabledAt: string | null;
  telegram: boolean;
}

export interface Accounts {
  accounts: AccountRow[];
  /** Whose are the changes from before accounts (actor "you"). */
  legacyOwner: string | null;
  /** Actor names of API tokens. */
  apps: string[];
}

export const useAuth = () =>
  useQuery({ queryKey: ["auth"], queryFn: () => get<AuthState>("/auth/state"), staleTime: 60_000 });

export const useMe = (): Me | null => useAuth().data?.me ?? null;

export const useAccounts = () =>
  useQuery({ queryKey: ["accounts"], queryFn: () => get<Accounts>("/accounts"), staleTime: 60_000 });

export interface ActorInfo {
  label: string;
  /** For people: their person thing, to link to. */
  personId: string | null;
  kind: "person" | "ai" | "app" | "burrow";
  /** Shown on hover: "kabbi", "app: pcb-rig", "before accounts". */
  title: string;
}

const BURROW: Record<string, string> = {
  burrow: "Burrow",
  migration: "a migration",
  import: "an import",
  "homebox-import": "HomeBox import",
  "homebox-sync": "HomeBox sync",
  "pcbphoto-import": "PCB photo import",
  telegram: "Telegram (not linked to an account)",
};

/** Names actors as people know them: accounts by their person's name, the rest in words. */
export function useActors(): (actor: string) => ActorInfo {
  const { data } = useAccounts();
  const me = useMe();
  return (actor) => {
    if (actor === "ai") return { label: "AI", personId: null, kind: "ai", title: "a model" };
    const username = actor === "you" ? (data?.legacyOwner ?? null) : actor;
    const a = data?.accounts.find((x) => x.username === username);
    if (a)
      return {
        label: a.username === me?.username ? "you" : a.name,
        personId: a.personId,
        kind: "person",
        title: actor === "you" ? `${a.name} (before accounts)` : `${a.name} · ${a.username}`,
      };
    if (actor === "you") return { label: "you", personId: null, kind: "person", title: "before accounts" };
    if (BURROW[actor]) return { label: BURROW[actor], personId: null, kind: "burrow", title: actor };
    return { label: actor, personId: null, kind: "app", title: `app: ${actor}` };
  };
}
