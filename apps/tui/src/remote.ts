import { createReadStream } from "node:fs";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";

// The app over pipes, for the web terminal (D-037). The server's bridge starts
// `burrow --remote` per browser tab: keys come on stdin, the screen goes to stdout, and the
// tab's size arrives as JSON lines on fd 3 ({"cols":120,"rows":40}). No PTY needed: the
// renderer draws for the size it is told.

export async function startRemote() {
  const cols = Number(process.env.COLUMNS) || 100;
  const rows = Number(process.env.LINES) || 30;
  // The renderer wants TTY-shaped streams (raw mode, a size); pipes pretend.
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode(b: boolean): unknown };
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
  process.stdin.on("data", (b) => (stdin as unknown as PassThrough).write(b));
  process.stdin.on("end", () => process.exit(0));
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns: cols, rows });
  (stdout as unknown as PassThrough).on("data", (b: Buffer) => process.stdout.write(b));

  const { startTui } = await import("./app/start.tsx");
  const app = await startTui({ stdin, stdout, width: cols, height: rows });

  try {
    const control = createInterface({ input: createReadStream("", { fd: 3 }) });
    control.on("line", (l) => {
      try {
        const m = JSON.parse(l) as { cols?: number; rows?: number };
        if (m.cols && m.rows) {
          Object.assign(stdout, { columns: m.cols, rows: m.rows });
          app.resize(m.cols, m.rows);
        }
      } catch {}
    });
    control.on("close", () => process.exit(0));
  } catch {
    // No control channel (run by hand): fixed size.
  }
}
