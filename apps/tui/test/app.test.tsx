import { afterAll, beforeAll, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { connect } from "../src/api.ts";
import { App } from "../src/app/App.tsx";
import { DARK, ThemeCtx } from "../src/app/theme.ts";

// The app against a tiny fake /api: search, open a thing, confirm an AI guess, undo it.

const thing = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  seq: Number(id.slice(2)),
  kind: "tool",
  name,
  data: {},
  meta: {},
  parentId: "B-0001",
  position: null,
  roams: false,
  status: "ok",
  createdAt: "2026-11-17T10:00:00Z",
  updatedAt: "2026-11-17T10:00:00Z",
  archivedAt: null,
  path: [{ id: "B-0001", name: "Workshop", kind: "room" }],
  refs: [],
  gaps: [],
  childCount: 0,
  tags: [],
  cover: null,
  ...extra,
});
const pinecil = thing("B-0207", "Pinecil V2", {
  data: { maker: "Pine64" },
  meta: { maker: { source: "ai", at: "2026-11-17T10:00:00Z" } },
});
const posts: string[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname.replace(/^\/api/, "");
      const json = (x: unknown) => Response.json(x);
      if (req.method === "POST") {
        posts.push(`${p} ${await req.text()}`);
        return json({
          thing: pinecil,
          event: {
            seq: 900 + posts.length,
            at: "",
            actor: "tester",
            body: { type: "thing.confirmed" },
            undoOf: null,
          },
        });
      }
      if (p === "/search")
        return json({
          hits: u.searchParams.get("q")?.startsWith("pine") ? [{ thing: pinecil, score: 1 }] : [],
        });
      if (p === "/things/B-0207")
        return json({
          thing: pinecil,
          fields: [{ key: "maker", label: "Maker", type: "text" }],
          children: [],
          relations: [],
          tagged: [],
          assets: [],
          coverId: null,
          spots: [],
          paperlessId: null,
          stock: [],
          mergedInto: null,
          events: [],
        });
      if (p === "/overview")
        return json({
          stats: { things: 1, places: 1, tags: 0, missing: 0, events: 1, documents: 0 },
          needsDetails: 0,
          missing: [],
          recentlyAdded: [pinecil],
        });
      if (p === "/events") return json({ events: [] });
      if (p === "/ai/providers")
        return json({
          anthropic: { configured: false, models: [] },
          ollama: { configured: false, models: [] },
          lmstudio: { configured: false, models: [] },
        });
      return json({});
    },
  });
  connect({ url: `http://localhost:${server.port}`, session: null });
});
afterAll(() => void server.stop(true));

test("search, open, confirm an AI guess, undo", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  const t = await testRender(
    <QueryClientProvider client={qc}>
      <ThemeCtx.Provider value={DARK}>
        <App
          me={{ username: "tester", name: "Tester", personId: "B-0002" }}
          url=""
          webUrl=""
          remote={false}
          quit={() => {}}
        />
      </ThemeCtx.Provider>
    </QueryClientProvider>,
    { width: 120, height: 30 },
  );
  const frame = async (want: string) => {
    for (let i = 0; i < 40; i++) {
      await t.renderOnce();
      if (t.captureCharFrame().includes(want)) return t.captureCharFrame();
      await Bun.sleep(25);
    }
    throw new Error(`"${want}" never showed:\n${t.captureCharFrame()}`);
  };
  await frame("Recently added");
  await t.mockInput.typeText("pine");
  await frame("1 match");
  t.mockInput.pressEnter();
  await frame("FIELD");
  expect(await frame("✦ Pine64")).toContain("y   n");
  // Down to Maker (Name, Kind, Maker), then "y": right.
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down");
  await t.renderOnce();
  t.mockInput.pressKey("y");
  await frame("Confirmed Maker");
  expect(posts.at(-1)).toBe('/things/B-0207/confirm {"fields":["maker"]}');
  t.mockInput.pressKey("u");
  await frame("Undone");
  expect(posts.at(-1)).toMatch(/^\/events\/\d+\/undo/);
  await t.dispose();
});
