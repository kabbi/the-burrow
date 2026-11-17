import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post, usd, type AiRecord, type Providers, type Quote, type ThingView } from "../api.ts";

// AI suggestions the web app's way (AiSuggest): quote → run → apply (accepted by default,
// violet until a person agrees). A local model runs straight away (free; still quoted and
// logged). A paid one shows its price and waits for ⏎. Nothing is spent before that.

export interface AiOption {
  key: string;
  provider: Quote["provider"];
  model: string;
  label: string;
  paid: boolean;
}

export type AiStep =
  | { s: "idle" }
  | { s: "quoting"; option: AiOption }
  | { s: "quoted"; quote: Quote }
  | { s: "running"; quote: Quote; started: number }
  | { s: "done"; rec: AiRecord; changed: string[] }
  | { s: "error"; message: string };

export function useAiOptions() {
  const { data: prov } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: () => get<Providers>("/ai/providers"),
    staleTime: 60_000,
  });
  const options: AiOption[] = !prov
    ? []
    : [
        // Only already-loaded LM Studio models (the server lists no others): picking one never loads a model.
        ...(prov.lmstudio?.configured
          ? prov.lmstudio.models.map((m) => ({
              key: `lmstudio:${m.name}`,
              provider: "lmstudio" as const,
              model: m.name,
              label: `${m.name} · local · free`,
              paid: false,
            }))
          : []),
        ...(prov.ollama.configured
          ? prov.ollama.models.map((m) => ({
              key: `ollama:${m.name}`,
              provider: "ollama" as const,
              model: m.name,
              label: `${m.name} · local · free`,
              paid: false,
            }))
          : []),
        ...(prov.anthropic.configured
          ? prov.anthropic.models.map((m) => ({
              key: `anthropic:${m.id}`,
              provider: "anthropic" as const,
              model: m.id,
              label: `${m.id} · paid, asks first`,
              paid: true,
            }))
          : []),
      ];
  // Like the web app: the free, already-loaded local model first; paid models are opt-in.
  const preferred =
    options.find((o) => o.provider === "lmstudio" && o.model === prov?.lmstudio.defaultModel) ??
    options.find((o) => !o.paid) ??
    options[0] ??
    null;
  return { options, preferred };
}

export function useSuggest(thingNow: ThingView | undefined) {
  const qc = useQueryClient();
  const [step, setStep] = useState<AiStep>({ s: "idle" });
  // The thing a run applies to: the one given to start(), else the screen's.
  const target = useRef<ThingView | undefined>(undefined);

  async function run(quote: Quote) {
    const thing = target.current ?? thingNow;
    if (!thing) return;
    setStep({ s: "running", quote, started: Date.now() });
    try {
      const { request } = await post<{ request: AiRecord }>(`/ai/requests/${quote.id}/run`);
      if (request.status !== "done") return setStep({ s: "error", message: request.error ?? request.status });
      const before = thing;
      const { thing: after } = await post<{ thing: ThingView }>(`/things/${thing.id}/apply-suggestion`, {
        requestId: quote.id,
      });
      const changed = Object.keys(after.meta).filter(
        (k) => after.meta[k]?.source === "ai" && after.meta[k]?.at !== before.meta[k]?.at,
      );
      setStep({ s: "done", rec: request, changed });
      await qc.invalidateQueries();
    } catch (e) {
      setStep({ s: "error", message: (e as Error).message });
    }
  }

  async function start(option: AiOption | null, given?: Record<string, unknown>, on?: ThingView) {
    target.current = on;
    const thing = on ?? thingNow;
    if (!thing || !option) return setStep({ s: "error", message: "No AI is set up on this Burrow" });
    setStep({ s: "quoting", option });
    try {
      const input = given ?? {
        name: thing.name,
        ...(typeof thing.data.url === "string" ? { url: thing.data.url } : {}),
      };
      const { quote } = await post<{ quote: Quote }>("/ai/quote", {
        task: "suggest-thing",
        input,
        provider: option.provider,
        model: option.model,
      });
      if (quote.autoApprove) return run(quote);
      setStep({ s: "quoted", quote });
    } catch (e) {
      setStep({ s: "error", message: (e as Error).message });
    }
  }

  return { step, start, run, reset: () => setStep({ s: "idle" }) };
}

/** One line about where a suggestion is. */
export function stepText(step: AiStep): string {
  switch (step.s) {
    case "idle":
      return "";
    case "quoting":
      return `${step.option.paid ? "Pricing" : "Asking"} ${step.option.model}…`;
    case "quoted": {
      const q = step.quote;
      return `${q.model}: ${q.estInputTokens.toLocaleString()} tokens in${q.tokensExact ? "" : " (est.)"} ≈ ${usd(q.estCostUsd)} (at most ${usd(q.maxCostUsd)}) · ⏎ run · esc cancel`;
    }
    case "running":
      return `${step.quote.model} is thinking… ${Math.round((Date.now() - step.started) / 1000)}s`;
    case "done":
      return `${step.rec.actualModel ?? step.rec.model} · ${step.rec.provider === "anthropic" ? usd(step.rec.actualCostUsd) : "free"} · ${step.changed.length ? `${step.changed.length} new guesses ✦` : "nothing new"}`;
    case "error":
      return `AI: ${step.message}`;
  }
}
