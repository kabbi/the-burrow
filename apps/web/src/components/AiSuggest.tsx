import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRefresh } from "../lib/hooks.ts";
import { get, post, usd, type AiRecord, type Providers, type Quote, type ThingView } from "../lib/api.ts";

type Step =
  | { s: "idle" }
  | { s: "quoting" }
  | { s: "quoted"; quote: Quote }
  | { s: "running"; quote: Quote }
  | { s: "done"; rec: AiRecord }
  | { s: "error"; message: string };

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
};

/**
 * Quote → (you agree) → run → apply. Nothing is spent until "Run" is pressed,
 * unless the quote's ceiling is under the auto-approve limit (default $0).
 */
export function AiSuggest({
  thingId,
  input,
  onApplied,
  autoStart = false,
  keep = [],
}: {
  thingId: string;
  input: Record<string, unknown>;
  onApplied: (t: ThingView, rec: AiRecord) => void;
  /** Ask for a quote as soon as it can: local models then run, paid ones show the price. */
  autoStart?: boolean;
  /** Fields the suggestion must not change (e.g. "name" when it's the household's own name). */
  keep?: string[];
}) {
  const { data: prov } = useQuery({
    queryKey: ["ai-providers"],
    queryFn: () => get<Providers>("/ai/providers"),
  });
  const [choice, setChoice] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ s: "idle" });
  const refresh = useRefresh();

  if (!prov) return null;
  const options = [
    ...(prov.lmstudio?.configured
      ? prov.lmstudio.models.map((m) => ({
          key: `lmstudio:${m.name}`,
          label: `${m.name} · LM Studio, local`,
        }))
      : []),
    ...(prov.anthropic.configured
      ? prov.anthropic.models.map((m) => ({ key: `anthropic:${m.id}`, label: MODEL_NAMES[m.id] ?? m.id }))
      : []),
    ...(prov.ollama.configured
      ? prov.ollama.models.map((m) => ({
          key: `ollama:${m.name}`,
          label: `${m.name} · local ${m.sizeGb} GB`,
        }))
      : []),
  ];
  if (!options.length)
    return <p className="muted small">No AI configured (set ANTHROPIC_API_KEY or OLLAMA_URL).</p>;
  // Default to the free, already-loaded local model; paid models are opt-in.
  const preferred = prov.lmstudio?.models.some((m) => m.name === prov.lmstudio.defaultModel)
    ? `lmstudio:${prov.lmstudio.defaultModel}`
    : prov.anthropic.configured
      ? `anthropic:${prov.anthropic.defaultModel}`
      : `ollama:${prov.ollama.defaultModel}`;
  const selected = choice ?? (options.some((o) => o.key === preferred) ? preferred : options[0]!.key);
  const [provider, ...rest] = selected.split(":");
  const model = rest.join(":");

  async function getQuote() {
    setStep({ s: "quoting" });
    try {
      const { quote: q } = await post<{ quote: Quote }>("/ai/quote", {
        task: "suggest-thing",
        input,
        provider,
        model,
      });
      if (q.autoApprove) return run(q);
      setStep({ s: "quoted", quote: q });
    } catch (e) {
      setStep({ s: "error", message: (e as Error).message });
    }
  }

  async function run(quote: Quote) {
    setStep({ s: "running", quote });
    try {
      const { request } = await post<{ request: AiRecord }>(`/ai/requests/${quote.id}/run`);
      if (request.status !== "done") return setStep({ s: "error", message: request.error ?? request.status });
      const { thing } = await post<{ thing: ThingView }>(`/things/${thingId}/apply-suggestion`, {
        requestId: quote.id,
        ...(keep.length ? { reject: keep } : {}),
      });
      setStep({ s: "done", rec: request });
      await refresh();
      onApplied(thing, request);
    } catch (e) {
      setStep({ s: "error", message: (e as Error).message });
    }
  }

  return (
    <div className="aibox" aria-live="polite">
      {autoStart && <OnMount run={getQuote} />}
      {(step.s === "idle" || step.s === "error" || step.s === "quoting") && (
        <div className="row">
          <button type="button" className="btn ai" onClick={getQuote} disabled={step.s === "quoting"}>
            {step.s === "quoting" ? (provider === "anthropic" ? "Pricing…" : "Starting…") : "Suggest details"}
          </button>
          <label className="row small muted" style={{ gap: 6 }}>
            with
            <select
              className="input"
              style={{ width: "auto", minHeight: 36 }}
              value={selected}
              onChange={(e) => setChoice(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <span className="muted small">
            {provider === "anthropic"
              ? "You’ll see the price before anything is spent."
              : "Local model: free, runs right away."}
          </span>
        </div>
      )}
      {step.s === "error" && (
        <p className="small" style={{ color: "var(--bad)", margin: 0 }}>
          {step.message}
        </p>
      )}
      {(step.s === "quoted" || step.s === "running") && (
        <>
          <div className="price">
            {step.quote.provider !== "anthropic" ? (
              <>
                Local model {step.quote.model} ({step.quote.provider === "lmstudio" ? "LM Studio" : "ollama"})
                · ~{step.quote.estInputTokens.toLocaleString()} tokens in · free, stays on your network
              </>
            ) : (
              <>
                {MODEL_NAMES[step.quote.model] ?? step.quote.model} ·{" "}
                {step.quote.estInputTokens.toLocaleString()} tokens in
                {step.quote.tokensExact ? "" : " (est.)"} + ~{step.quote.estOutputTokens} out ≈{" "}
                <strong>{usd(step.quote.estCostUsd)}</strong> (at most {usd(step.quote.maxCostUsd)})
              </>
            )}
          </div>
          <div className="row">
            <button
              type="button"
              className="btn ai"
              onClick={() => run(step.quote)}
              disabled={step.s === "running"}
            >
              {step.s === "running"
                ? "Thinking…"
                : step.quote.provider !== "anthropic"
                  ? "Run locally"
                  : `Run · ≈${usd(step.quote.estCostUsd)}`}
            </button>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => setStep({ s: "idle" })}
              disabled={step.s === "running"}
            >
              Cancel
            </button>
          </div>
        </>
      )}
      {step.s === "done" && (
        <div className="row small">
          <span className="dot ai" />
          <span>
            Filled in by {MODEL_NAMES[step.rec.actualModel ?? ""] ?? step.rec.actualModel} ·{" "}
            {step.rec.provider !== "anthropic" ? "local, free" : `cost ${usd(step.rec.actualCostUsd)}`}.
            Violet lines are guesses — click one if it’s wrong.
          </span>
        </div>
      )}
    </div>
  );
}

/** Runs `run` once, when first shown (the auto start, after the providers are known). */
function OnMount({ run }: { run: () => Promise<void> }) {
  // oxlint-disable-next-line react/exhaustive-deps -- once on mount, on purpose
  useEffect(() => void run(), []);
  return null;
}
