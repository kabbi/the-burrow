import { useQuery } from "@tanstack/react-query";
import { get, usd, type AiRecord } from "../lib/api.ts";
import { timeAgo } from "../lib/hooks.ts";

export function AiLog() {
  const { data } = useQuery({
    queryKey: ["ai-log"],
    queryFn: () =>
      get<{ requests: AiRecord[]; spend: { totalUsd: number; monthUsd: number; runs: number } }>(
        "/ai/requests",
      ),
  });
  return (
    <main className="page">
      <h1 style={{ fontSize: 34 }}>AI requests</h1>
      {data && (
        <p className="muted" style={{ margin: 0 }}>
          {usd(data.spend.monthUsd)} this month · {usd(data.spend.totalUsd)} total · {data.spend.runs} runs.
          Every request is priced before it runs; quotes you didn’t run cost nothing.
        </p>
      )}
      <section className="panel flat">
        <div className="list">
          {data?.requests.map((r) => (
            <div className="list-row" key={r.id}>
              <span style={{ flex: "1 1 160px" }}>
                <strong>{r.task}</strong> <span className="muted small">{timeAgo(r.createdAt)}</span>
              </span>
              <span className="mono" style={{ flex: "1 1 200px" }}>
                {r.provider}/{r.actualModel ?? r.model}
              </span>
              <span className="mono" style={{ flex: "1 1 220px" }}>
                {r.actualInputTokens !== null
                  ? `${r.actualInputTokens}+${r.actualOutputTokens} tok · ${usd(r.actualCostUsd)}`
                  : `quote ${r.estInputTokens}+${r.estOutputTokens} tok · ${usd(r.estCostUsd)}`}
              </span>
              <span
                className={`tag${r.status === "failed" ? "" : ""}`}
                style={
                  r.status === "failed" ? { background: "var(--bad-tint)", color: "var(--bad)" } : undefined
                }
              >
                {r.status}
              </span>
              {r.error && (
                <span className="small" style={{ flexBasis: "100%", color: "var(--bad)" }}>
                  {r.error}
                </span>
              )}
            </div>
          ))}
          {data?.requests.length === 0 && <p className="muted">No AI requests yet.</p>}
        </div>
      </section>
    </main>
  );
}
