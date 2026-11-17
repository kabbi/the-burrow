// Draw the app headlessly against a running server (BURROW_URL / BURROW_SESSION) and print frames.
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { authState, connect } from "../src/api.ts";
import { resolveConn } from "../src/config.ts";
import { App } from "../src/app/App.tsx";
import { DARK, ThemeCtx } from "../src/app/theme.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

export async function draw(w: number, h: number) {
  const conn = resolveConn();
  connect(conn);
  const st = await authState();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  const setup = await testRender(
    <QueryClientProvider client={qc}>
      <ThemeCtx.Provider value={DARK}>
        <App me={st.me} url={conn.url} webUrl={conn.url} remote={false} quit={() => {}} />
      </ThemeCtx.Provider>
    </QueryClientProvider>,
    { width: w, height: h },
  );
  const settle = async (ms = 400) => {
    await new Promise((r) => setTimeout(r, ms));
    await setup.renderOnce();
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
  };
  return { ...setup, settle, frame: () => setup.captureCharFrame() };
}
