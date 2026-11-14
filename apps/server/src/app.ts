import express, { type ErrorRequestHandler } from "express";
import { mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
import { BurrowError, Store } from "@burrow/core";
import type { Config } from "./config.ts";
import { Paperless, PaperlessOff, type PaperlessApi } from "./adapters/paperless.ts";
import { PaperlessMock } from "./adapters/paperless-mock.ts";
import { UpstreamError } from "./adapters/http.ts";
import { AiError, AiGateway, aiMigrations } from "./ai/gateway.ts";
import { AnthropicProvider, LmStudioProvider, OllamaProvider } from "./ai/providers.ts";
import { suggestThingTask } from "./ai/tasks.ts";
import { thingRoutes } from "./routes/things.ts";
import { paperRoutes } from "./routes/papers.ts";
import { aiRoutes } from "./routes/ai.ts";
import { dbRoutes } from "./routes/db.ts";
import { schemaRoutes } from "./routes/schema.ts";

export interface Deps {
  config: Config;
  store: Store;
  paperless: PaperlessApi;
  inboxTagNames: string[];
  ai: AiGateway;
  ollama: OllamaProvider;
  lmstudio: LmStudioProvider;
  anthropic: AnthropicProvider;
}

export function createDeps(config: Config, overrides: Partial<Deps> = {}): Deps {
  const store = overrides.store ?? Store.open(config.db, aiMigrations);
  const ollama = new OllamaProvider(config.ai.ollamaUrl);
  const lmstudio = new LmStudioProvider(config.ai.lmstudioUrl);
  const anthropic = new AnthropicProvider(config.ai.anthropicKey);
  const ai = new AiGateway(store.db, [lmstudio, ollama, anthropic], {
    autoApproveUsd: config.ai.autoApproveUsd,
  });
  ai.register(suggestThingTask(store));
  const p = config.paperless;
  const paperless: PaperlessApi = p.mock
    ? new PaperlessMock()
    : p.url && p.token
      ? new Paperless(p.url, p.token)
      : new PaperlessOff();
  return {
    config,
    store,
    paperless,
    inboxTagNames: p.inboxTags.map((s) => s.toLowerCase()),
    ai,
    ollama,
    lmstudio,
    anthropic,
    ...overrides,
  };
}

export function createApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  const api = express.Router();
  api.get("/health", (_req, res) => res.json({ ok: true, version: process.env.BURROW_VERSION ?? "dev" }));

  api.get("/overview", async (_req, res) => {
    const { store, paperless } = deps;
    const inboxCount = await countInbox(deps).catch(() => null);
    res.json({
      stats: store.stats(),
      needsDetails: store.needsDetails(500).length,
      missing: store.list({ limit: 500 }).filter((t) => t.status === "missing"),
      recentlyAdded: store.list({ physical: true, limit: 6 }),
      moves: store
        .events({ types: ["thing.moved", "thing.status", "thing.created"], limit: 8 })
        .filter((e) => e.actor === "you" || e.actor === "ai"),
      papers: { mode: paperless.mode, inbox: inboxCount },
      ai: deps.ai.spend(),
    });
  });

  api.use(thingRoutes(deps));
  api.use(schemaRoutes(deps));
  api.use(paperRoutes(deps));
  api.use(aiRoutes(deps));
  if (deps.config.dbAdmin) api.use(dbRoutes(deps));
  api.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use("/api", api);

  // Files Burrow owns (photos…), content-addressed so they can be cached forever.
  mkdirSync(deps.config.mediaDir, { recursive: true });
  app.use(
    "/media",
    express.static(deps.config.mediaDir, { immutable: true, maxAge: "365d", fallthrough: false }),
  );

  // Production: serve the built web app.
  const web = new URL("../../web/dist/", import.meta.url).pathname;
  if (existsSync(web)) {
    app.use(express.static(web));
    app.get("/{*path}", (_req, res) => res.sendFile(`${web}index.html`));
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    // Bad SQL typed into the DB browser is the caller's mistake, not a server error.
    if ((err as { code?: string }).code === "ERR_SQLITE_ERROR")
      return res.status(400).json({ error: (err as Error).message });
    if (err instanceof ZodError)
      return res.status(400).json({ error: "Invalid request", issues: err.issues });
    if (err instanceof BurrowError || err instanceof AiError || err instanceof UpstreamError)
      return res.status(err.status >= 400 ? err.status : 502).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: (err as Error).message ?? "Internal error" });
  };
  app.use(onError);
  return app;
}

async function countInbox(deps: Deps): Promise<number> {
  const tax = await deps.paperless.taxonomy();
  const ids = tax.tags
    .filter((t) => t.is_inbox_tag || deps.inboxTagNames.includes(t.name.toLowerCase()))
    .map((t) => t.id);
  const [a, b] = await Promise.all([
    ids.length ? deps.paperless.documents({ tagsAny: ids, pageSize: 100 }) : { results: [] },
    deps.paperless.documents({ untriaged: true, pageSize: 100 }),
  ]);
  return new Set([...a.results, ...b.results].map((d) => d.id)).size;
}
