import { createCliRenderer, type CliRendererConfig } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { authState, connect } from "../api.ts";
import { resolveConn } from "../config.ts";
import { App } from "./App.tsx";
import { pickTheme, ThemeCtx } from "./theme.ts";

/** Streams and size for a terminal that isn't this process's own (the web terminal, tests). */
export interface Io {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  width: number;
  height: number;
}

const fail = (msg: string, code: number): never => {
  process.stderr.write(`burrow: ${msg}\n`);
  process.exit(code);
};

export async function startTui(io?: Io): Promise<{ resize(w: number, h: number): void }> {
  const conn = resolveConn();
  connect(conn);
  const st = await authState().catch((e: Error) =>
    fail(`Can't reach Burrow at ${conn.url}: ${e.message}`, 1),
  );
  if (st.auth && !st.me) fail(`Not signed in to ${conn.url}. Run: burrow login ${conn.url}`, 2);

  const config: CliRendererConfig = {
    exitOnCtrlC: false,
    useMouse: true,
    autoFocus: false,
    targetFps: 30,
    ...(io ? { stdin: io.stdin, stdout: io.stdout, width: io.width, height: io.height, remote: true } : {}),
  };
  const renderer = await createCliRenderer(config);
  const theme = pickTheme(await renderer.waitForThemeMode(300).catch(() => null));
  renderer.setBackgroundColor(theme.bg);
  renderer.setTerminalTitle("burrow");

  let quitting = false;
  const quit = () => {
    if (quitting) return;
    quitting = true;
    renderer.destroy();
    void renderer.closed.finally(() => process.exit(0));
  };
  // The session ended elsewhere (signed out, expired): leave with a word instead of failing on.
  connect(conn, () => {
    renderer.destroy();
    void renderer.closed.finally(() => fail(`Signed out. Run: burrow login ${conn.url}`, 2));
  });

  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false } },
  });
  createRoot(renderer).render(
    <QueryClientProvider client={qc}>
      <ThemeCtx.Provider value={theme}>
        <App
          me={st.me}
          url={conn.url}
          webUrl={process.env.BURROW_WEB_URL || conn.url}
          remote={Boolean(io)}
          quit={quit}
        />
      </ThemeCtx.Provider>
    </QueryClientProvider>,
  );
  return { resize: (w, h) => renderer.resize(w, h) };
}
