import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../lib/api.ts";
import { timeAgo } from "../lib/hooks.ts";

// The API page (D-020): tokens for outside systems, and a readable reference built from
// the server's own OpenAPI document (/api/v1/openapi.json), so it is always current.

interface Token {
  id: string;
  name: string;
  actor: string;
  scopes: string[];
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

type Schema = {
  type?: string | string[];
  $ref?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: Schema | boolean;
  format?: string;
};
interface Param {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema: Schema;
}
interface Operation {
  operationId: string;
  tags: string[];
  summary: string;
  description?: string;
  "x-scope": string;
  parameters: Param[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
}
interface Spec {
  info: { description: string; version: string };
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
}

export function Api() {
  const tokens = useQuery({
    queryKey: ["tokens"],
    queryFn: () => get<{ tokens: Token[]; scopes: { id: string; description: string }[] }>("/tokens"),
  });
  const spec = useQuery({ queryKey: ["openapi"], queryFn: () => get<Spec>("/v1/openapi.json") });
  const origin = window.location.origin;

  return (
    <main className="page">
      <h1 style={{ fontSize: 34 }}>API</h1>
      <p className="muted" style={{ margin: 0, maxWidth: 760 }}>
        For outside systems such as the PCB rig. Each token acts as an <em>actor</em>: everything it changes
        is recorded under that name in the history, and can be undone there. The reference below is generated
        from{" "}
        <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
          <span className="mono">/api/v1/openapi.json</span>
        </a>{" "}
        (OpenAPI 3.1), which works with any OpenAPI tool or client generator.
      </p>
      <Tokens data={tokens.data} origin={origin} />
      {spec.data ? (
        <Reference spec={spec.data} origin={origin} />
      ) : (
        <p className="muted">Loading the reference…</p>
      )}
    </main>
  );
}

// ------------------------------------------------------------------ tokens

function Tokens({
  data,
  origin,
}: {
  data: { tokens: Token[]; scopes: { id: string; description: string }[] } | undefined;
  origin: string;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [actor, setActor] = useState("");
  const [scopes, setScopes] = useState<string[]>(["write"]);
  const [made, setMade] = useState<{ token: string; info: Token } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);

  const create = async () => {
    setError(null);
    try {
      const r = await post<{ token: string; info: Token }>("/tokens", {
        name,
        actor: actor || slug(name),
        scopes,
      });
      setMade(r);
      setName("");
      setActor("");
      await qc.invalidateQueries({ queryKey: ["tokens"] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const revoke = async (t: Token) => {
    if (!confirm(`Revoke "${t.name}"? Apps using it stop working at once.`)) return;
    await post(`/tokens/${t.id}/revoke`);
    await qc.invalidateQueries({ queryKey: ["tokens"] });
  };
  const live = data?.tokens.filter((t) => !t.revokedAt) ?? [];
  const revoked = data?.tokens.filter((t) => t.revokedAt) ?? [];

  return (
    <section className="panel stack">
      <h2 className="eyebrow">Tokens</h2>
      {made && (
        <div className="api-secret stack">
          <strong>Token for {made.info.name}: copy it now, it won't be shown again.</strong>
          <div className="row">
            <code className="mono api-code" style={{ flex: 1 }}>
              {made.token}
            </code>
            <button
              type="button"
              className="btn small"
              onClick={() => void navigator.clipboard.writeText(made.token)}
            >
              Copy
            </button>
            <button type="button" className="btn small ghost" onClick={() => setMade(null)}>
              Done
            </button>
          </div>
          <pre className="api-code">{`curl -H "Authorization: Bearer ${made.token}" ${origin}/api/v1/me`}</pre>
        </div>
      )}
      <div className="list">
        {live.map((t) => (
          <div className="list-row" key={t.id}>
            <span style={{ flex: "1 1 160px" }}>
              <strong>{t.name}</strong> <span className="muted small">…{t.hint}</span>
            </span>
            <span className="mono" style={{ flex: "0 1 160px" }}>
              as {t.actor}
            </span>
            <span style={{ flex: "0 1 160px" }}>
              {t.scopes.map((s) => (
                <span key={s} className="tag" style={{ marginRight: 4 }}>
                  {s}
                </span>
              ))}
            </span>
            <span className="muted small" style={{ flex: "1 1 160px" }}>
              {t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : "never used"} · made {timeAgo(t.createdAt)}
            </span>
            <button type="button" className="btn small ghost" onClick={() => void revoke(t)}>
              Revoke
            </button>
          </div>
        ))}
        {data && !live.length && <p className="muted">No tokens yet.</p>}
      </div>
      <form
        className="row api-new"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="field" style={{ flex: "1 1 180px" }}>
          <span>What uses it</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="PCB photo rig"
            required
          />
        </label>
        <label className="field" style={{ flex: "1 1 160px" }}>
          <span>Actor (shown in history)</span>
          <input
            value={actor}
            onChange={(e) => setActor(slug(e.target.value))}
            placeholder={slug(name) || "pcb-rig"}
            className="mono"
          />
        </label>
        <fieldset className="row" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
          {data?.scopes.map((s) => (
            <button
              key={s.id}
              type="button"
              className="chip"
              title={s.description}
              aria-pressed={scopes.includes(s.id)}
              onClick={() =>
                setScopes((old) => (old.includes(s.id) ? old.filter((x) => x !== s.id) : [...old, s.id]))
              }
            >
              {s.id}
            </button>
          ))}
        </fieldset>
        <button type="submit" className="btn main" disabled={!name.trim() || !scopes.length}>
          Make a token
        </button>
      </form>
      {error && <p style={{ color: "var(--bad)", margin: 0 }}>{error}</p>}
      <p className="muted small" style={{ margin: 0 }}>
        {data?.scopes.map((s) => (
          <span key={s.id}>
            <strong>{s.id}</strong>: {s.description}{" "}
          </span>
        ))}
      </p>
      {revoked.length > 0 && (
        <details className="small muted">
          <summary>{revoked.length} revoked</summary>
          {revoked.map((t) => (
            <div key={t.id}>
              {t.name} (as {t.actor}), revoked {timeAgo(t.revokedAt!)}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ reference

function Reference({ spec, origin }: { spec: Spec; origin: string }) {
  const ops = Object.entries(spec.paths).flatMap(([path, m]) =>
    Object.entries(m).map(([method, o]) => ({ path, method, ...o })),
  );
  return (
    <>
      <section className="panel stack">
        <h2 className="eyebrow">How it works</h2>
        <Markdownish text={spec.info.description} />
        <pre className="api-code">{`curl -H "Authorization: Bearer $BURROW_TOKEN" \\
  -X PUT ${origin}/api/v1/refs/my-app/item-42 \\
  -H "content-type: application/json" \\
  -d '{"name": "ESP32 dev board", "parentPath": "Workshop / Drawer 3", "tags": ["esp32"]}'`}</pre>
      </section>
      {spec.tags.map((tag) => (
        <section className="panel stack" key={tag.name} id={`api-${tag.name}`}>
          <div>
            <h2 className="eyebrow">{tag.name}</h2>
            <div className="muted small">
              <Markdownish text={tag.description} />
            </div>
          </div>
          {ops
            .filter((o) => o.tags.includes(tag.name))
            .map((o) => (
              <OperationView key={o.operationId} op={o} />
            ))}
        </section>
      ))}
      <section className="panel stack">
        <h2 className="eyebrow">Shapes</h2>
        {Object.entries(spec.components.schemas).map(([name, s]) => (
          <details key={name} id={`schema-${name}`} className="api-op">
            <summary>
              <span className="mono">
                <strong>{name}</strong>
              </span>{" "}
              {s.description && <span className="muted small">{s.description}</span>}
            </summary>
            <SchemaView schema={s} />
          </details>
        ))}
      </section>
    </>
  );
}

function OperationView({ op }: { op: Operation & { path: string; method: string } }) {
  const body = op.requestBody && Object.entries(op.requestBody.content)[0];
  const ok = Object.entries(op.responses).find(([code]) => code.startsWith("2"));
  const okSchema = ok?.[1].content?.["application/json"]?.schema;
  return (
    <details className="api-op">
      <summary>
        <span className={`api-method api-${op.method}`}>{op.method.toUpperCase()}</span>{" "}
        <span className="mono">{op.path}</span> <span className="muted">{op.summary}</span>{" "}
        <span className="tag">{op["x-scope"]}</span>
      </summary>
      <div className="stack" style={{ padding: "8px 0 4px" }}>
        {op.description && <Markdownish text={op.description} />}
        {op.parameters.length > 0 && (
          <div>
            <div className="eyebrow">Parameters</div>
            <table className="api-table">
              <tbody>
                {op.parameters.map((p) => (
                  <tr key={p.in + p.name}>
                    <td className="mono">
                      {p.name}
                      {p.required ? "" : "?"}
                    </td>
                    <td className="muted small">{p.in}</td>
                    <td className="mono small">{typeName(p.schema)}</td>
                    <td className="small">{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {body && (
          <div>
            <div className="eyebrow">Body · {body[0]}</div>
            <SchemaView schema={body[1].schema} />
          </div>
        )}
        {okSchema && (
          <div>
            <div className="eyebrow">Answer · {ok[0]}</div>
            <SchemaView schema={okSchema} />
          </div>
        )}
      </div>
    </details>
  );
}

/** An object's properties as a table; anything else as one type name. */
function SchemaView({ schema }: { schema: Schema }) {
  if (!schema.properties) return <div className="mono small">{typeName(schema)}</div>;
  const req = new Set(schema.required ?? []);
  return (
    <table className="api-table">
      <tbody>
        {Object.entries(schema.properties).map(([k, p]) => (
          <tr key={k}>
            <td className="mono">
              {k}
              {req.has(k) ? "" : "?"}
            </td>
            <td className="mono small">{typeName(p)}</td>
            <td className="small">
              {p.description ?? p.items?.description}
              {p.default !== undefined && (
                <span className="muted"> (default {JSON.stringify(p.default)})</span>
              )}
              {p.properties && <SchemaView schema={p} />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function typeName(s: Schema): ReactNode {
  if (s.$ref) {
    const name = s.$ref.split("/").at(-1)!;
    return <a href={`#schema-${name}`}>{name}</a>;
  }
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.anyOf)
    return s.anyOf.map((x, i) => (
      <span key={i}>
        {i > 0 && " | "}
        {typeName(x)}
      </span>
    ));
  if (s.type === "array" && s.items) return <>{typeName(s.items)}[]</>;
  if (s.format === "binary") return "file";
  if (s.type === "object" && !s.properties) {
    const v = typeof s.additionalProperties === "object" ? s.additionalProperties : null;
    return v && (v.$ref || v.type) ? (
      <>
        {"{ [key]: "}
        {typeName(v)}
        {" }"}
      </>
    ) : (
      "object"
    );
  }
  if (Array.isArray(s.type)) return s.type.join(" | ");
  return s.type ?? "any";
}

/** Paragraphs with **bold** and `code`: enough for the spec's own descriptions. */
function Markdownish({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n\n+/).map((para, i) => (
        <p key={i} style={{ margin: 0, maxWidth: 820 }}>
          {para.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, j) =>
            part.startsWith("**") ? (
              <strong key={j}>{part.slice(2, -2)}</strong>
            ) : part.startsWith("`") ? (
              <code key={j} className="mono">
                {part.slice(1, -1)}
              </code>
            ) : (
              part
            ),
          )}
        </p>
      ))}
    </>
  );
}
