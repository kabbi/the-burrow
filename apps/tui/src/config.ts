import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where the terminal app connects and as whom (D-037). `burrow login` saves the session cookie
// here (mode 600); BURROW_URL / BURROW_SESSION override it (the web terminal's bridge uses them).

export interface Saved {
  url: string;
  session?: string;
  username?: string;
}

export interface Conn {
  url: string;
  session: string | null;
}

const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "burrow");
export const configPath = join(dir, "tui.json");
export const DEFAULT_URL = "http://localhost:4100";

export function loadSaved(): Saved | null {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as Saved;
  } catch {
    return null;
  }
}

export function save(s: Saved) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

export function forget() {
  rmSync(configPath, { force: true });
}

export const cleanUrl = (u: string) =>
  u
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");

export function resolveConn(): Conn {
  const saved = loadSaved();
  return {
    url: cleanUrl(process.env.BURROW_URL || saved?.url || DEFAULT_URL),
    session: process.env.BURROW_SESSION || saved?.session || null,
  };
}
