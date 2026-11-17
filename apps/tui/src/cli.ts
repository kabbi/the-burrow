import { createInterface } from "node:readline";
import {
  asId,
  authState,
  connect,
  eventLabel,
  get,
  login,
  post,
  type EventRow,
  type Hits,
  type Place,
  type ThingDetail,
  type ThingView,
} from "./api.ts";
import { cleanUrl, configPath, DEFAULT_URL, forget, loadSaved, resolveConn, save } from "./config.ts";
import { resolvePlace } from "./places.ts";
import { ago, fit, hasWhere, valueText, whereText } from "./text.ts";

// The same binary as a plain command (D-037): no TTY or a command → text (or --json) on stdout.

export const HELP = `burrow: your home's things, from the terminal

  burrow                       the full-screen app (in a terminal)
  burrow login [url]           sign in (default ${DEFAULT_URL}); saved in ${configPath}
  burrow logout                forget the saved session
  burrow whoami                who you are signed in as, and where
  burrow find <words…>         search (names, fields, tags, spots, paths, IDs)
  burrow show <id>             one thing: where it is, its facts, its history
  burrow add <name> [--in <place>] [--spot <spot>] [--kind <kind>] [--qty <n>]
  burrow mv <id> <place> [--spot <spot>]     put it somewhere ("-" = take it out)
  burrow lost <id> / found <id>              "it's not here" / found it again
  burrow undo [seq]            undo your last change (or event #seq; again = redo)

  --json   machine-readable output        places: an ID, a path ("Hall/Shelf") or a unique name
`;

interface Args {
  pos: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (["json", "help", "remote"].includes(k)) flags[k] = true;
      else flags[k] = argv[++i] ?? "";
    } else pos.push(a);
  }
  return { pos, flags };
}

class UserError extends Error {}

const out = (s: string) => process.stdout.write(`${s}\n`);

async function ask(prompt: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  if (hidden) {
    const w = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
    let muted = false;
    w._writeToOutput = (s) => void (!muted || s.includes("\n") ? w.output.write(muted ? "\n" : s) : 0);
    const p = new Promise<string>((res) => rl.question(prompt, res));
    muted = true;
    const a = await p;
    rl.close();
    return a;
  }
  const a = await new Promise<string>((res) => rl.question(prompt, res));
  rl.close();
  return a;
}

/** Signed in (or a server without sign-in)? Answers who. */
export async function whoami(): Promise<{ url: string; who: string | null; auth: boolean }> {
  const conn = resolveConn();
  connect(conn);
  const s = await authState().catch((e: Error) => {
    throw new UserError(`Can't reach Burrow at ${conn.url}: ${e.message}`);
  });
  if (s.auth && !s.me) throw new UserError(`Not signed in to ${conn.url}. Run: burrow login ${conn.url}`);
  return { url: conn.url, who: s.me?.username ?? null, auth: s.auth };
}

async function places(): Promise<Place[]> {
  return (await get<{ places: Place[] }>("/places")).places;
}

async function place(input: string): Promise<Place> {
  const p = resolvePlace(input, await places());
  if ("error" in p) throw new UserError(p.error);
  return p;
}

function mustId(s: string | undefined, what = "an ID"): string {
  const id = s ? asId(s) : null;
  if (!id) throw new UserError(`Give ${what} (like B-0042 or b42)`);
  return id;
}

const row = (t: ThingView) => `${t.id}  ${fit(t.name, 40)}  ${whereText(t, 60)}`;

export async function runCommand(argv: string[]): Promise<number> {
  const { pos, flags } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  const json = flags.json === true;
  const print = (data: unknown, text: () => string) => out(json ? JSON.stringify(data, null, 2) : text());
  try {
    switch (cmd) {
      case undefined:
      case "help":
        out(HELP);
        return 0;
      case "login": {
        const url = cleanUrl(rest[0] ?? loadSaved()?.url ?? DEFAULT_URL);
        connect({ url, session: null });
        const s = await authState();
        if (!s.auth) {
          save({ url });
          out(`${url} doesn't ask anyone to sign in. Saved.`);
          return 0;
        }
        const username = (typeof flags.user === "string" && flags.user) || (await ask("Username: ")).trim();
        const password = process.stdin.isTTY
          ? await ask("Password: ", true)
          : (await new Response(Bun.stdin.stream()).text()).split("\n")[0]!;
        const session = await login(url, username, password);
        save({ url, session, username });
        out(`Signed in to ${url} as ${username}.`);
        return 0;
      }
      case "logout": {
        const conn = resolveConn();
        connect(conn);
        if (conn.session) await post("/auth/logout").catch(() => {});
        forget();
        out("Signed out.");
        return 0;
      }
      case "whoami": {
        const w = await whoami();
        print(w, () => (w.auth ? `${w.who} at ${w.url}` : `${w.url} (no sign-in)`));
        return 0;
      }
      case "find":
      case "search": {
        await whoami();
        const q = rest.join(" ");
        if (!q) throw new UserError("What are you looking for? burrow find <words>");
        const { hits } = await get<Hits>(
          `/search?q=${encodeURIComponent(q)}&limit=${Number(flags.limit) || 30}`,
        );
        print(
          hits.map((h) => h.thing),
          () => (hits.length ? hits.map((h) => row(h.thing)).join("\n") : `Nothing matches "${q}".`),
        );
        return hits.length ? 0 : 1;
      }
      case "show": {
        await whoami();
        const d = await get<ThingDetail>(`/things/${mustId(rest[0])}`);
        print(d, () => {
          const t = d.thing;
          const lines = [`${t.id}  ${t.name}  (${t.kind}${t.status === "ok" ? "" : `, ${t.status}`})`];
          if (hasWhere(t)) lines.push(`in ${whereText(t)}`);
          for (const f of d.fields) {
            const v = valueText(t.data[f.key]);
            if (v)
              lines.push(
                `  ${fit(f.label, 16)} ${v}${t.meta[f.key]?.source === "ai" && !t.meta[f.key]?.confirmed ? "  (AI guess)" : ""}`,
              );
          }
          if (t.tags.length) lines.push(`  ${fit("Tags", 16)} ${t.tags.map((x) => x.name).join(", ")}`);
          if (d.children.length)
            lines.push(`inside: ${d.children.map((c) => `${c.name} (${c.id})`).join(", ")}`);
          lines.push("history:");
          for (const e of d.events.slice(0, 8))
            lines.push(
              `  #${e.seq}  ${fit(ago(e.at), 5)} ${fit(e.actor, 10)} ${eventLabel(e)}${e.undone ? " (undone)" : ""}`,
            );
          return lines.join("\n");
        });
        return 0;
      }
      case "add": {
        await whoami();
        const name = rest.join(" ").trim();
        if (!name) throw new UserError('Name it: burrow add "ESP32-CAM" --in "Working Room"');
        const to = typeof flags.in === "string" ? await place(flags.in) : null;
        const qty = Number(flags.qty);
        const r = await post<{ thing: ThingView }>("/things", {
          name,
          ...(typeof flags.kind === "string" ? { kind: flags.kind } : {}),
          ...(to ? { parentId: to.id } : {}),
          ...(qty > 1 ? { data: { quantity: qty } } : {}),
        });
        let t = r.thing;
        if (to && typeof flags.spot === "string")
          t = (await post<{ thing: ThingView }>(`/things/${t.id}/move`, { to: to.id, position: flags.spot }))
            .thing;
        print(t, () => `Added ${t.name} as ${t.id}${to ? ` in ${whereText(t)}` : " (not placed yet)"}`);
        return 0;
      }
      case "mv":
      case "move": {
        await whoami();
        const id = mustId(rest[0]);
        const where = rest.slice(1).join(" ");
        if (!where) throw new UserError('Where to? burrow mv B-0042 "Hall/Shelf" (or - to take it out)');
        const to = where === "-" ? null : await place(where);
        const { thing } = await post<{ thing: ThingView }>(`/things/${id}/move`, {
          to: to?.id ?? null,
          ...(typeof flags.spot === "string" ? { position: flags.spot } : {}),
        });
        print(thing, () => `Moved ${thing.name} → ${whereText(thing)}`);
        return 0;
      }
      case "lost":
      case "found": {
        await whoami();
        const id = mustId(rest[0]);
        const { thing } = await post<{ thing: ThingView }>(`/things/${id}/status`, {
          status: cmd === "lost" ? "missing" : "ok",
        });
        print(thing, () => `${thing.name}: ${cmd === "lost" ? "marked missing" : "found"}`);
        return 0;
      }
      case "undo": {
        const w = await whoami();
        let seq = Number(rest[0]);
        if (!seq) {
          const { events } = await get<{ events: EventRow[] }>("/events?limit=100");
          const mine = events.find(
            (e) => e.undoable && !e.undone && !e.undoOf && (!w.auth || e.actor === w.who),
          );
          if (!mine) throw new UserError("Nothing of yours to undo lately");
          seq = mine.seq;
        }
        const r = await post<{ event: unknown; original?: EventRow }>(`/events/${seq}/undo`);
        print(r, () => `Undid #${seq}${r.original ? `: ${eventLabel(r.original)}` : ""}`);
        return 0;
      }
      default:
        throw new UserError(`Unknown command "${cmd}". Try: burrow help`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`burrow: ${msg}\n`);
    return e instanceof UserError ? 2 : 1;
  }
}
