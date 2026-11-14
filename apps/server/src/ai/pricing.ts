// USD per 1M tokens, Anthropic first-party rates (from the claude-api skill,
// cached 2026-11-03). Update here when prices change; docs/context.md links the source.
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-2": { input: 8, output: 40 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

/** Models offered in the UI picker, cheapest last. */
export const ANTHROPIC_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

/** Server-side fallback when the chosen model declines (policy refusal). */
export const FALLBACK_FOR: Record<string, string> = {
  "claude-opus-5-5": "claude-opus-4-8",
  "claude-sonnet-5-5": "claude-sonnet-5",
};

export function costUsd(model: string, input: number, output: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (input * p.input + output * p.output) / 1_000_000;
}
