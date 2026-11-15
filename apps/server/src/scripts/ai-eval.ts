// Compare models on the suggest-thing task with a fixed set of inputs.
//   node src/scripts/ai-eval.ts lmstudio qwen/qwen3.8-27b [more provider:model pairs…]
// Uses the real gateway (quote → run), so every call shows up in the AI log.
// Local providers only unless --allow-paid is passed (then the quoted total is printed first).
import { Store } from "@burrow/core";
import { config } from "../config.ts";
import { AiGateway, aiMigrations } from "../ai/gateway.ts";
import {
  AnthropicProvider,
  LmStudioProvider,
  LOCAL_PROVIDERS,
  OllamaProvider,
  type ProviderId,
} from "../ai/providers.ts";
import { suggestThingTask, ThingSuggestion } from "../ai/tasks.ts";

export const EVAL_INPUTS = process.env.EVAL_ONLY
  ? process.env.EVAL_ONLY.split("|")
  : [
      "metal calipers",
      "moka pot",
      "ESP32-CAM AI-Thinker",
      "3mm flicker LEDs red white orange",
      "large monstera plant",
      "nail clippers",
      "IKEA LAGAN dishwasher",
      "2m USB-C to USB-C cable 100W",
    ];

const args = process.argv.slice(2);
const allowPaid = args.includes("--allow-paid");
/** Price every request (free token counting) without running anything. */
const quoteOnly = args.includes("--quote-only");
const targets = args
  .filter((a) => !a.startsWith("--"))
  .map((a) => {
    const [provider, ...rest] = a.split(":");
    return { provider: provider as ProviderId, model: rest.join(":") };
  });
if (!targets.length) {
  console.error("usage: ai-eval.ts <provider>:<model> …   e.g. lmstudio:qwen/qwen3.8-27b");
  process.exit(1);
}

const store = Store.open(config.db, aiMigrations);
const ai = new AiGateway(store.db, [
  new LmStudioProvider(config.ai.lmstudioUrl),
  new OllamaProvider(config.ai.ollamaUrl),
  new AnthropicProvider(config.ai.anthropicKey),
]);
ai.register(suggestThingTask(store));

for (const t of targets) {
  if (quoteOnly) {
    let est = 0;
    let max = 0;
    for (const name of EVAL_INPUTS) {
      const q = await ai.quote("suggest-thing", { name }, t.provider, t.model);
      est += q.estCostUsd ?? 0;
      max += q.maxCostUsd ?? 0;
    }
    console.log(
      `${t.provider}:${t.model}  ${EVAL_INPUTS.length} requests  est $${est.toFixed(4)}  worst case $${max.toFixed(4)}`,
    );
    continue;
  }
  if (!LOCAL_PROVIDERS.has(t.provider) && !allowPaid) {
    console.error(`${t.provider} costs money: re-run with --allow-paid after checking the quote`);
    continue;
  }
  console.log(`\n=== ${t.provider}:${t.model}`);
  for (const name of EVAL_INPUTS) {
    const q = await ai.quote("suggest-thing", { name }, t.provider, t.model);
    const started = Date.now();
    const rec = await ai.run(q.id);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (rec.status !== "done") {
      console.log(JSON.stringify({ name, secs, error: rec.error }));
      continue;
    }
    const s = ThingSuggestion.parse(rec.result);
    console.log(
      JSON.stringify({
        input: name,
        secs,
        tok: `${rec.actualInputTokens}+${rec.actualOutputTokens}`,
        name: s.name,
        kind: s.kind,
        maker: s.maker,
        model: s.model,
        qty: s.quantity,
        place: s.placeId ? `${s.placeId} ${store.getRaw(s.placeId)?.name ?? "?"}` : null,
        desc: s.description,
        q: s.question?.text ?? null,
      }),
    );
  }
}
