import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { ANTHROPIC_MODELS, PRICES } from "../ai/pricing.ts";

export function aiRoutes({ ai, ollama, lmstudio, anthropic, config }: Deps): Router {
  const r = Router();

  r.get("/ai/providers", async (_req, res) => {
    const [models, lms] = await Promise.all([
      ollama.models().catch(() => null),
      lmstudio.configured ? lmstudio.models().catch(() => null) : Promise.resolve(null),
    ]);
    res.json({
      anthropic: {
        configured: anthropic.configured,
        defaultModel: config.ai.anthropicModel,
        models: ANTHROPIC_MODELS.map((id) => ({ id, ...PRICES[id] })),
      },
      ollama: {
        configured: ollama.configured && models !== null,
        defaultModel: config.ai.ollamaModel,
        // embeddings models can't answer questions
        models: (models ?? []).filter((m) => !m.name.includes("embed")),
      },
      lmstudio: {
        configured: lmstudio.configured && lms !== null,
        defaultModel: config.ai.lmstudioModel,
        // only already-loaded models: picking one never triggers a load
        models: (lms ?? []).filter((m) => m.loaded),
      },
      spend: ai.spend(),
      autoApproveUsd: config.ai.autoApproveUsd,
    });
  });

  r.post("/ai/quote", async (req, res) => {
    const b = z
      .object({
        task: z.string(),
        input: z.unknown(),
        provider: z.enum(["anthropic", "ollama", "lmstudio"]),
        model: z.string().optional(),
      })
      .parse(req.body);
    const model =
      b.model ??
      {
        anthropic: config.ai.anthropicModel,
        ollama: config.ai.ollamaModel,
        lmstudio: config.ai.lmstudioModel,
      }[b.provider];
    res.json({ quote: await ai.quote(b.task, b.input, b.provider, model) });
  });

  r.post("/ai/requests/:id/run", async (req, res) => {
    res.json({ request: await ai.run(req.params.id) });
  });

  r.get("/ai/requests/:id", (req, res) => {
    const rec = ai.get(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    res.json({ request: rec });
  });

  r.get("/ai/requests", (_req, res) => res.json({ requests: ai.list(100), spend: ai.spend() }));

  return r;
}
