// Accounts from the command line (D-032): the way back in when nobody can sign in.
//
//   pnpm --filter @burrow/server account list
//   pnpm --filter @burrow/server account add <username> "<Name>"   (asks for the password)
//   pnpm --filter @burrow/server account passwd <username>
//   pnpm --filter @burrow/server account disable|enable <username>
//   pnpm --filter @burrow/server account sign-out <username>
//
// In production: pnpm prod:account … (runs it in the container). A password can also come
// on stdin: `echo secret | … account passwd kabbi`.
import { createInterface } from "node:readline";
import { Store } from "@burrow/core";
import { config } from "../config.ts";
import { Accounts } from "../auth/accounts.ts";
import { tokenMigrations } from "../api/tokens.ts";

const store = Store.open(config.db, tokenMigrations);
const accounts = new Accounts(store);
const [cmd, ...args] = process.argv.slice(2);

async function askPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let s = "";
    for await (const chunk of process.stdin) s += String(chunk);
    return s.split("\n")[0]!.trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted || s.includes("\n")) out.output.write(muted ? "\n" : s);
  };
  const answer = await new Promise<string>((resolve) => {
    rl.question(prompt, resolve);
    muted = true;
  });
  rl.close();
  return answer;
}

async function newPassword(): Promise<string> {
  const a = await askPassword("Password: ");
  if (process.stdin.isTTY && (await askPassword("Again: ")) !== a) throw new Error("The passwords differ");
  return a;
}

const usage =
  'usage: account list | add <username> "<Name>" | passwd <username> | disable <username> | enable <username> | sign-out <username>';

if (cmd === "list" || !cmd) {
  const owner = accounts.legacyOwner()?.username;
  for (const a of accounts.list())
    console.log(
      `${a.username.padEnd(16)} ${a.name} (${a.personId})` +
        `${a.username === owner ? "  [owner: earlier changes]" : ""}` +
        `${a.hasPassword ? "" : "  no password"}${a.disabledAt ? "  DISABLED" : ""}` +
        `  passkeys: ${accounts.passkeys(a.username).length}, sessions: ${accounts.sessionCount(a.username)}`,
    );
  if (!accounts.count())
    console.log("No accounts yet: open Burrow to create the first one, or `account add`.");
} else if (cmd === "add" && args[0]) {
  const a = await accounts.create({
    username: args[0],
    name: args[1] ?? args[0],
    password: await newPassword(),
  });
  console.log(`added ${a.username}: ${a.name} (${a.personId})`);
} else if (cmd === "passwd" && args[0]) {
  await accounts.setPassword(args[0], await newPassword());
  const n = accounts.endSessions(args[0]);
  console.log(`password changed for ${args[0]}; ${n} session(s) signed out`);
} else if ((cmd === "disable" || cmd === "enable") && args[0]) {
  accounts.setDisabled(args[0], cmd === "disable");
  console.log(`${args[0]} ${cmd}d`);
} else if (cmd === "sign-out" && args[0]) {
  console.log(`${accounts.endSessions(args[0])} session(s) signed out`);
} else throw new Error(usage);
