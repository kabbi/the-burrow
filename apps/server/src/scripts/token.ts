// API tokens from the command line (D-020); the web app's API page does the same.
//
//   pnpm --filter @burrow/server token list
//   pnpm --filter @burrow/server token create "PCB rig" pcb-rig write[,schema]
//   pnpm --filter @burrow/server token revoke tok_…
import { openDb } from "@burrow/core";
import { config } from "../config.ts";
import { SCOPES, Tokens, tokenMigrations, type Scope } from "../api/tokens.ts";

const tokens = new Tokens(openDb(config.db, tokenMigrations));
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "create") {
  const [name, actor, scopes = "write"] = args;
  if (!name || !actor) throw new Error('usage: token create "<name>" <actor> [read|write|schema,…]');
  const { token, info } = tokens.create({ name, actor, scopes: scopes.split(",") as Scope[] });
  console.log(`${info.id}  ${info.name} as ${info.actor} [${info.scopes.join(",")}]`);
  console.log(`token (shown once): ${token}`);
} else if (cmd === "revoke" && args[0]) {
  const t = tokens.revoke(args[0]);
  console.log(`revoked ${t.id} (${t.name})`);
} else if (cmd === "list" || !cmd) {
  for (const t of tokens.list())
    console.log(
      `${t.id}  ${t.name} as ${t.actor} [${t.scopes.join(",")}] …${t.hint}` +
        `${t.revokedAt ? "  REVOKED" : ""}  last used ${t.lastUsedAt ?? "never"}`,
    );
} else throw new Error(`usage: token list | create "<name>" <actor> [${SCOPES.join("|")}] | revoke <id>`);
