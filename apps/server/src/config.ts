// All configuration comes from the environment (root .env, loaded by node --env-file).
const env = process.env;
const strip = (u: string | undefined) => (u ?? "").replace(/\/+$/, "").replace(/\/home$/, "");

export const config = {
  port: Number(env.PORT ?? 4100),
  /** Built-in database browser at /db (D-009). On unless BURROW_DB_ADMIN=0. */
  dbAdmin: env.BURROW_DB_ADMIN !== "0",
  db: env.BURROW_DB ?? new URL("../../../data/burrow.sqlite", import.meta.url).pathname,
  /** Photos and other files Burrow owns (content-addressed). Served at /media. */
  mediaDir: env.BURROW_MEDIA ?? new URL("../../../data/media", import.meta.url).pathname,
  /** Stable Fast 3D server (photo → textured .glb). Empty = off. */
  sf3dUrl: strip(env.SF3D_URL),
  /** Only used by the one-time import script (D-010). */
  homebox: {
    url: strip(env.HOMEBOX_URL),
    token: env.HOMEBOX_TOKEN ?? "",
  },
  paperless: {
    url: strip(env.PAPERLESS_NGX_URL),
    token: env.PAPERLESS_NGX_TOKEN ?? "",
    mock: env.PAPERLESS_MOCK === "1",
    /** Tag names that mean "scanned, not filed yet", besides paperless' own inbox tags. */
    inboxTags: (env.PAPERLESS_INBOX_TAGS ?? "inbox")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  ai: {
    ollamaUrl: strip(env.OLLAMA_URL),
    ollamaModel: env.OLLAMA_MODEL ?? "qwen3.5:9b",
    lmstudioUrl: strip(env.LMSTUDIO_URL ?? env.LLM_STUDIO_URL),
    lmstudioModel: env.LMSTUDIO_MODEL ?? "google/gemma-4-31b",
    anthropicKey: env.ANTHROPIC_API_KEY ?? env.ANTROPIC_API_KEY ?? "",
    anthropicModel: env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
    /** Requests quoted at or below this many USD run without asking. 0 = always ask. */
    autoApproveUsd: Number(env.AI_AUTO_APPROVE_USD ?? 0),
  },
};

export type Config = typeof config;
