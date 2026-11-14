import { randomUUID } from "node:crypto";
import type { Db, Migration } from "@burrow/core";
import type { z } from "zod";
import { costUsd } from "./pricing.ts";
import { LOCAL_PROVIDERS, type Prompt, type Provider, type ProviderId } from "./providers.ts";

export const aiMigrations: Migration[] = [
  {
    id: "ai/001-requests",
    sql: `
      create table ai_requests (
        id text primary key,
        created_at text not null,
        task text not null,
        provider text not null,
        model text not null,
        confidential integer not null default 0,
        prompt text not null,
        input text not null,
        status text not null,            -- quoted | running | done | failed | expired
        est_input_tokens integer not null,
        est_output_tokens integer not null,
        est_cost_usd real,
        max_cost_usd real,
        tokens_exact integer not null default 0,
        actual_model text,
        actual_input_tokens integer,
        actual_output_tokens integer,
        actual_cost_usd real,
        result text,
        error text,
        finished_at text
      );
      create index ai_requests_created on ai_requests(created_at);
    `,
  },
];

export interface AiTask<I, O> {
  id: string;
  /** Confidential input (e.g. document text) may only go to local models. */
  confidential: boolean;
  schema: z.ZodType<O>;
  maxTokens: number;
  /** Typical output size incl. thinking, for the estimate. */
  expectedOutputTokens: number;
  build(input: I): Prompt | Promise<Prompt>;
}

export interface Quote {
  id: string;
  task: string;
  provider: ProviderId;
  model: string;
  confidential: boolean;
  estInputTokens: number;
  estOutputTokens: number;
  tokensExact: boolean;
  /** null for local models (no money involved). */
  estCostUsd: number | null;
  maxCostUsd: number | null;
  autoApprove: boolean;
  expiresAt: string;
}

export interface AiRecord extends Quote {
  createdAt: string;
  status: string;
  actualModel: string | null;
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  actualCostUsd: number | null;
  error: string | null;
  result: unknown;
}

const QUOTE_TTL_MS = 15 * 60_000;

/**
 * Every AI call is two steps: quote (free: builds the prompt and counts
 * tokens) and run (spends money). The UI shows the quote's price and only
 * runs it after the person agrees. docs/decisions.md D-007.
 */
export class AiGateway {
  private db: Db;
  private providers: Record<ProviderId, Provider>;
  private tasks = new Map<string, AiTask<unknown, unknown>>();
  private autoApproveUsd: number;

  constructor(db: Db, providers: Provider[], opts: { autoApproveUsd?: number } = {}) {
    this.db = db;
    this.providers = Object.fromEntries(providers.map((p) => [p.id, p])) as Record<ProviderId, Provider>;
    this.autoApproveUsd = opts.autoApproveUsd ?? 0;
  }

  register<I, O>(task: AiTask<I, O>) {
    this.tasks.set(task.id, task as AiTask<unknown, unknown>);
  }

  async quote(taskId: string, input: unknown, provider: ProviderId, model: string): Promise<Quote> {
    const task = this.task(taskId);
    const p = this.providers[provider];
    if (!p?.configured) throw new AiError(`${provider} is not configured`, 503);
    const local = LOCAL_PROVIDERS.has(provider);
    if (task.confidential && !local)
      throw new AiError("This task reads private documents: only local models are allowed", 403);
    const prompt = await task.build(input);
    const { tokens, exact } = await p.countTokens(prompt, model, task.schema);
    const est = costUsd(model, tokens, task.expectedOutputTokens);
    const max = costUsd(model, tokens, task.maxTokens);
    if (provider === "anthropic" && est === null) throw new AiError(`No price known for ${model}`, 400);
    const q: Quote = {
      id: randomUUID(),
      task: taskId,
      provider,
      model,
      confidential: task.confidential,
      estInputTokens: tokens,
      estOutputTokens: task.expectedOutputTokens,
      tokensExact: exact,
      estCostUsd: local ? null : est,
      maxCostUsd: local ? null : max,
      // Local models are free: run right away (owner's call). Paid ones wait for a yes
      // unless their worst case is under AI_AUTO_APPROVE_USD.
      autoApprove: local || (max ?? Infinity) <= this.autoApproveUsd,
      expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    };
    this.db
      .prepare(
        `insert into ai_requests (id, created_at, task, provider, model, confidential, prompt, input, status,
           est_input_tokens, est_output_tokens, est_cost_usd, max_cost_usd, tokens_exact)
         values (?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?, ?, ?, ?)`,
      )
      .run(
        q.id,
        new Date().toISOString(),
        taskId,
        provider,
        model,
        task.confidential ? 1 : 0,
        JSON.stringify(prompt),
        JSON.stringify(input ?? null),
        tokens,
        q.estOutputTokens,
        q.estCostUsd,
        q.maxCostUsd,
        exact ? 1 : 0,
      );
    return q;
  }

  /** Spend: runs a quote the person approved. Each quote runs at most once. */
  async run(id: string): Promise<AiRecord> {
    const rec = this.get(id);
    if (!rec) throw new AiError("No such AI request", 404);
    if (rec.status !== "quoted") throw new AiError(`Request is already ${rec.status}`, 409);
    if (Date.parse(rec.expiresAt) < Date.now()) {
      this.db.prepare("update ai_requests set status = 'expired' where id = ?").run(id);
      throw new AiError("Quote expired, ask for a new one", 410);
    }
    const claimed = this.db
      .prepare("update ai_requests set status = 'running' where id = ? and status = 'quoted'")
      .run(id);
    if (Number(claimed.changes) !== 1) throw new AiError("Request is already running", 409);

    const task = this.task(rec.task);
    const row = this.db.prepare("select prompt from ai_requests where id = ?").get(id) as { prompt: string };
    const prompt = JSON.parse(row.prompt) as Prompt;
    try {
      const out = await this.providers[rec.provider].complete(prompt, rec.model, task.schema, task.maxTokens);
      const cost = LOCAL_PROVIDERS.has(rec.provider)
        ? null
        : costUsd(out.model, out.inputTokens, out.outputTokens);
      this.db
        .prepare(
          `update ai_requests set status = 'done', actual_model = ?, actual_input_tokens = ?,
             actual_output_tokens = ?, actual_cost_usd = ?, result = ?, finished_at = ? where id = ?`,
        )
        .run(
          out.model,
          out.inputTokens,
          out.outputTokens,
          cost,
          JSON.stringify(out.output),
          new Date().toISOString(),
          id,
        );
    } catch (e) {
      this.db
        .prepare("update ai_requests set status = 'failed', error = ?, finished_at = ? where id = ?")
        .run((e as Error).message, new Date().toISOString(), id);
    }
    return this.get(id)!;
  }

  get(id: string): AiRecord | null {
    const r = this.db.prepare("select * from ai_requests where id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? toRecord(r) : null;
  }

  list(limit = 50): AiRecord[] {
    return (
      this.db.prepare("select * from ai_requests order by created_at desc limit ?").all(limit) as Record<
        string,
        unknown
      >[]
    ).map(toRecord);
  }

  spend() {
    const r = this.db
      .prepare(
        `select coalesce(sum(actual_cost_usd), 0) total,
                coalesce(sum(case when created_at >= ? then actual_cost_usd end), 0) month,
                count(case when status = 'done' then 1 end) runs
         from ai_requests`,
      )
      .get(new Date().toISOString().slice(0, 7)) as { total: number; month: number; runs: number };
    return { totalUsd: r.total, monthUsd: r.month, runs: r.runs };
  }

  private task(id: string) {
    const t = this.tasks.get(id);
    if (!t) throw new AiError(`Unknown AI task ${id}`, 404);
    return t;
  }
}

export class AiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function toRecord(r: Record<string, unknown>): AiRecord {
  const created = String(r.created_at);
  return {
    id: String(r.id),
    task: String(r.task),
    provider: r.provider as ProviderId,
    model: String(r.model),
    confidential: Number(r.confidential) === 1,
    estInputTokens: Number(r.est_input_tokens),
    estOutputTokens: Number(r.est_output_tokens),
    tokensExact: Number(r.tokens_exact) === 1,
    estCostUsd: (r.est_cost_usd as number | null) ?? null,
    maxCostUsd: (r.max_cost_usd as number | null) ?? null,
    autoApprove: false,
    expiresAt: new Date(Date.parse(created) + QUOTE_TTL_MS).toISOString(),
    createdAt: created,
    status: String(r.status),
    actualModel: (r.actual_model as string | null) ?? null,
    actualInputTokens: (r.actual_input_tokens as number | null) ?? null,
    actualOutputTokens: (r.actual_output_tokens as number | null) ?? null,
    actualCostUsd: (r.actual_cost_usd as number | null) ?? null,
    error: (r.error as string | null) ?? null,
    result: typeof r.result === "string" ? JSON.parse(r.result) : null,
  };
}
