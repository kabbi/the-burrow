import { parseArgs, runCommand } from "./cli.ts";

// One entry point (D-037): a terminal and no command → the full-screen app; a command, or no
// terminal → plain output; --remote → the app over pipes, for the web terminal's bridge.
const argv = process.argv.slice(2);
const { pos, flags } = parseArgs(argv);

if (flags.remote) {
  const { startRemote } = await import("./remote.ts");
  await startRemote();
} else if (!pos.length && !flags.help && process.stdin.isTTY && process.stdout.isTTY) {
  const { startTui } = await import("./app/start.tsx");
  await startTui();
} else {
  process.exit(await runCommand(argv));
}
