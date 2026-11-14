import Anthropic, { AuthenticationError } from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { FALLBACK_FOR } from "./pricing.ts";

export interface Prompt {
  system: string;
  user: string;
}

export type ProviderId = "anthropic" | "ollama" | "lmstudio";
/** Local providers cost no money and may see confidential input. */
export const LOCAL_PROVIDERS: ReadonlySet<ProviderId> = new Set(["ollama", "lmstudio"]);

export interface Completion<O> {
  output: O;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface Provider {
  readonly id: ProviderId;
  readonly configured: boolean;
  /** Exact (anthropic, free endpoint) or estimated (ollama) prompt tokens. */
  countTokens(prompt: Prompt, model: string, schema: z.ZodType): Promise<{ tokens: number; exact: boolean }>;
  complete<O>(prompt: Prompt, model: string, schema: z.ZodType<O>, maxTokens: number): Promise<Completion<O>>;
}

export class AiRefusal extends Error {}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic" as const;
  private client: Anthropic | null;

  constructor(apiKey: string) {
    this.client = apiKey ? new Anthropic({ apiKey, maxRetries: 1 }) : null;
  }

  get configured() {
    return this.client !== null;
  }

  private must() {
    if (!this.client) throw new Error("ANTHROPIC_API_KEY is not set");
    return this.client;
  }

  async countTokens(p: Prompt, model: string, schema: z.ZodType) {
    // count_tokens is free; it includes the structured-output schema overhead.
    try {
      const r = await this.must().beta.messages.countTokens({
        model,
        system: p.system,
        messages: [{ role: "user", content: p.user }],
        output_config: { format: betaZodOutputFormat(schema) },
      });
      return { tokens: r.input_tokens, exact: true };
    } catch (e) {
      if (e instanceof AuthenticationError)
        throw new Error("Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY in .env.", {
          cause: e,
        });
      throw e;
    }
  }

  async complete<O>(
    p: Prompt,
    model: string,
    schema: z.ZodType<O>,
    maxTokens: number,
  ): Promise<Completion<O>> {
    const fallback = FALLBACK_FOR[model];
    const res = await this.must().beta.messages.parse({
      model,
      max_tokens: maxTokens,
      system: p.system,
      messages: [{ role: "user", content: p.user }],
      output_config: { format: betaZodOutputFormat(schema), effort: "low" },
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: [{ model: fallback }] } : {}),
    });
    if (res.stop_reason === "refusal") throw new AiRefusal("The model declined this request");
    if (res.stop_reason === "max_tokens") throw new Error("The answer was cut off (max_tokens)");
    if (!res.parsed_output) throw new Error("The model returned no parseable output");
    return {
      output: res.parsed_output as O,
      model: res.model,
      inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0),
      outputTokens: res.usage.output_tokens,
    };
  }
}

/**
 * Local models on the GPU box. Treated with care (docs/decisions.md D-007):
 * one request at a time, never pulls models, short keep_alive so VRAM is freed.
 */
export class OllamaProvider implements Provider {
  readonly id = "ollama" as const;
  private url: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(url: string) {
    this.url = url;
  }

  get configured() {
    return Boolean(this.url);
  }

  async models(): Promise<{ name: string; sizeGb: number; params: string }[]> {
    const r = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`ollama HTTP ${r.status}`);
    const j = (await r.json()) as {
      models: { name: string; size: number; details?: { parameter_size?: string } }[];
    };
    return j.models.map((m) => ({
      name: m.name,
      sizeGb: Math.round(m.size / 1e8) / 10,
      params: m.details?.parameter_size ?? "",
    }));
  }

  async countTokens(p: Prompt, _model: string, schema: z.ZodType) {
    // No tokenizer endpoint; ~3.5 chars per token is close enough for a quote.
    const chars = p.system.length + p.user.length + JSON.stringify(z.toJSONSchema(schema)).length;
    return { tokens: Math.ceil(chars / 3.5), exact: false };
  }

  complete<O>(p: Prompt, model: string, schema: z.ZodType<O>, maxTokens: number): Promise<Completion<O>> {
    const run = async () => {
      const installed = await this.models();
      if (!installed.some((m) => m.name === model))
        throw new Error(`ollama model "${model}" is not installed (Burrow never pulls models)`);
      const r = await fetch(`${this.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(180_000),
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          keep_alive: "2m",
          format: z.toJSONSchema(schema),
          options: { temperature: 0.2, num_predict: maxTokens, num_ctx: 8192 },
          messages: [
            { role: "system", content: p.system },
            { role: "user", content: p.user },
          ],
        }),
      });
      if (!r.ok) throw new Error(`ollama HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = (await r.json()) as {
        message: { content: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const output = schema.parse(JSON.parse(j.message.content));
      return { output, model, inputTokens: j.prompt_eval_count ?? 0, outputTokens: j.eval_count ?? 0 };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}

/**
 * LM Studio (OpenAI-compatible API). Only uses models that are already
 * loaded; never asks LM Studio to load or download anything.
 */
export class LmStudioProvider implements Provider {
  readonly id = "lmstudio" as const;
  private url: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(url: string) {
    this.url = url;
  }

  get configured() {
    return Boolean(this.url);
  }

  async models(): Promise<{ name: string; loaded: boolean; type: string; context: number }[]> {
    const r = await fetch(`${this.url}/api/v0/models`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`lmstudio HTTP ${r.status}`);
    const j = (await r.json()) as {
      data: { id: string; type: string; state: string; max_context_length?: number }[];
    };
    return j.data
      .filter((m) => m.type !== "embeddings")
      .map((m) => ({
        name: m.id,
        loaded: m.state === "loaded",
        type: m.type,
        context: m.max_context_length ?? 0,
      }));
  }

  async countTokens(p: Prompt, _model: string, schema: z.ZodType) {
    const chars = p.system.length + p.user.length + JSON.stringify(z.toJSONSchema(schema)).length;
    return { tokens: Math.ceil(chars / 3.5), exact: false };
  }

  complete<O>(p: Prompt, model: string, schema: z.ZodType<O>, maxTokens: number): Promise<Completion<O>> {
    const run = async () => {
      const m = (await this.models()).find((x) => x.name === model);
      if (!m?.loaded) throw new Error(`LM Studio model "${model}" is not loaded (Burrow never loads models)`);
      const r = await fetch(`${this.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(300_000),
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: maxTokens,
          stream: false,
          response_format: {
            type: "json_schema",
            json_schema: { name: "answer", strict: true, schema: z.toJSONSchema(schema) },
          },
          messages: [
            { role: "system", content: p.system },
            { role: "user", content: p.user },
          ],
        }),
      });
      if (!r.ok) throw new Error(`lmstudio HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = (await r.json()) as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const output = schema.parse(JSON.parse(j.choices[0]?.message.content ?? "null"));
      return {
        output,
        model,
        inputTokens: j.usage?.prompt_tokens ?? 0,
        outputTokens: j.usage?.completion_tokens ?? 0,
      };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}
