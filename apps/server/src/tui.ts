import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Deps } from "./app.ts";
import { COOKIE, cookieFrom } from "./routes/auth.ts";

// The web terminal (D-037): the web app's /terminal page opens a WebSocket here, and each tab
// gets its own copy of the terminal app (`burrow --remote`, apps/tui, on Bun), signed in as
// the person whose browser session opened it. Keys go to its stdin, the screen comes back
// from its stdout, the tab's size goes over fd 3. No PTY: the app draws for the size it's told.

export const TUI_PATH = "/api/tui";
const MAX_PER_ACCOUNT = 4;

const tuiDir = new URL("../../tui/", import.meta.url).pathname;
const bunPath = process.env.BURROW_BUN || `${tuiDir}node_modules/.bin/bun`;
const entry = `${tuiDir}src/main.tsx`;

/** Messages from the browser: keys, or the terminal's size. */
type FromBrowser = { t: "i"; d: string } | { t: "r"; cols: number; rows: number };

export function tuiAvailable(): boolean {
  return existsSync(bunPath) && existsSync(entry);
}

export function attachTui(server: Server, deps: Deps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const running = new Map<string, Set<ChildProcess>>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== TUI_PATH) return;
    const refuse = (code: number, text: string) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    // A page on another site must not open a terminal with your cookie (cross-site WebSocket).
    const origin = req.headers.origin;
    let originHost = "";
    try {
      originHost = origin ? new URL(origin).host : "";
    } catch {}
    if (!origin || originHost !== req.headers.host) return refuse(403, "Forbidden");
    if (!tuiAvailable()) return refuse(503, "Service Unavailable");

    const secret = cookieFrom(req.headers.cookie, COOKIE);
    const account = deps.config.auth ? (secret ? deps.accounts.session(secret) : null) : null;
    if (deps.config.auth && !account) return refuse(401, "Unauthorized");
    const who = account?.username ?? "you";
    const mine = running.get(who) ?? new Set();
    if (mine.size >= MAX_PER_ACCOUNT) return refuse(429, "Too Many Requests");

    wss.handleUpgrade(req, socket, head, (ws) => {
      const cols = clamp(Number(url.searchParams.get("cols")), 20, 400, 100);
      const rows = clamp(Number(url.searchParams.get("rows")), 8, 200, 30);
      const theme = url.searchParams.get("theme");
      const child = start(deps, { secret: account ? secret : null, cols, rows, theme });
      mine.add(child);
      running.set(who, mine);
      pipe(ws, child, () => {
        mine.delete(child);
        if (!mine.size) running.delete(who);
      });
    });
  });
  return wss;
}

const clamp = (n: number, lo: number, hi: number, dflt: number) =>
  Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;

function start(
  deps: Deps,
  o: { secret: string | null; cols: number; rows: number; theme: string | null },
): ChildProcess {
  // A clean environment: the child gets the way back to this server and nothing else
  // (no API keys, bot tokens or paperless credentials).
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLUMNS: String(o.cols),
    LINES: String(o.rows),
    BURROW_URL: `http://127.0.0.1:${deps.config.port}`,
    BURROW_WEB_URL: deps.config.publicUrl,
    XDG_CONFIG_HOME: "/nonexistent",
    ...(o.secret ? { BURROW_SESSION: o.secret } : {}),
    ...(o.theme === "light" || o.theme === "dark" ? { BURROW_THEME: o.theme } : {}),
  };
  return spawn(bunPath, [entry, "--remote"], { env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
}

function pipe(ws: WebSocket, child: ChildProcess, done: () => void) {
  const control = child.stdio[3] as NodeJS.WritableStream | null;
  let closed = false;
  const end = (code: number, why: string) => {
    if (closed) return;
    closed = true;
    done();
    if (child.exitCode === null) child.kill("SIGTERM");
    if (ws.readyState === ws.OPEN) ws.close(code, why);
  };
  child.stdout?.on("data", (b: Buffer) => ws.readyState === ws.OPEN && ws.send(b));
  let errors = "";
  child.stderr?.on("data", (b: Buffer) => {
    errors = (errors + b.toString()).slice(-2000);
  });
  child.on("exit", (code) => {
    if (code && errors.trim()) console.error(`[tui] exited ${code}: ${errors.trim().split("\n").at(-1)}`);
    // The browser shows why the terminal ended ("Signed out…", "Not signed in…").
    const why =
      errors
        .trim()
        .split("\n")
        .at(-1)
        ?.replace(/^burrow: /, "")
        .slice(0, 120) || "ended";
    end(1000, code ? why : "ended");
  });
  child.on("error", (e) => end(1011, e.message.slice(0, 120)));
  ws.on("message", (raw) => {
    let m: FromBrowser;
    try {
      m = JSON.parse(String(raw)) as FromBrowser;
    } catch {
      return;
    }
    if (m.t === "i" && typeof m.d === "string") child.stdin?.write(m.d);
    else if (m.t === "r")
      control?.write(
        `${JSON.stringify({ cols: clamp(m.cols, 20, 400, 100), rows: clamp(m.rows, 8, 200, 30) })}\n`,
      );
  });
  ws.on("close", () => end(1000, "closed"));
}
