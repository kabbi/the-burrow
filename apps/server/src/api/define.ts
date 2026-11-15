import express, { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { BurrowError, type Store } from "@burrow/core";
import { allows, SCOPE_INFO, SCOPES, type ApiToken, type Scope, type Tokens } from "./tokens.ts";
import { runAs } from "../auth/context.ts";

// One definition per operation drives both the HTTP route (validation, auth, attribution)
// and the OpenAPI document, so the docs can't drift from what the server does (D-020).

type Method = "get" | "post" | "put" | "patch" | "delete";
type Obj = z.ZodObject<z.ZodRawShape>;

export interface FilePart {
  data: Buffer;
  filename: string;
  type: string;
}

export interface Ctx<P, Q, B> {
  params: P;
  query: Q;
  body: B;
  /** multipart file parts by field name. */
  files: Record<string, FilePart>;
  token: ApiToken;
  /** Who the events are recorded under. */
  actor: string;
  req: Request;
}

export interface Multipart {
  /** Binary parts; `true` = required. */
  files: Record<string, { required: boolean; description: string }>;
  /** A JSON part named "meta", validated with this schema. */
  meta: z.ZodType;
}

export interface OpDef<P extends Obj, Q extends Obj, B extends z.ZodType> {
  method: Method;
  /** OpenAPI style: /things/{id} */
  path: string;
  id: string;
  tag: string;
  summary: string;
  description?: string;
  scope: Scope;
  params?: P;
  query?: Q;
  body?: B;
  multipart?: Multipart;
  response: z.ZodType;
  status?: number;
  run(ctx: Ctx<z.infer<P>, z.infer<Q>, z.infer<B>>): unknown;
}

// oxlint-disable-next-line typescript/no-explicit-any
export type AnyOp = OpDef<any, any, any>;

export function op<
  P extends Obj = z.ZodObject<{}>,
  Q extends Obj = z.ZodObject<{}>,
  B extends z.ZodType = z.ZodUnknown,
>(def: OpDef<P, Q, B>): AnyOp {
  return def;
}

/**
 * Shared schemas that become `#/components/schemas/<id>`. They live in zod's global registry,
 * next to every `.describe()` text, so one conversion sees both.
 */
export function component<T extends z.ZodType>(id: string, schema: T): T {
  const meta = z.globalRegistry.get(schema);
  z.globalRegistry.add(schema, { ...meta, id });
  return schema;
}

export const ErrorBody = component(
  "Error",
  z.object({
    error: z.string(),
    issues: z.array(z.unknown()).optional().describe("Validation problems, for 400s."),
  }),
);

/** Writes answer with what they did, plus the events they appended (for undo and audit). */
const writes = (s: Scope) => s !== "read";

// ------------------------------------------------------------------ routing

export function bindOps(ops: AnyOp[], deps: { store: Store; tokens: Tokens }): Router {
  const r = Router();
  const auth: RequestHandler = (req, res, next) => {
    const h = req.get("authorization") ?? "";
    const secret = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    const token = secret ? deps.tokens.verify(secret) : null;
    if (!token)
      return void res
        .status(401)
        .set("www-authenticate", 'Bearer realm="burrow"')
        .json({ error: secret ? "Unknown or revoked token" : "Send Authorization: Bearer <token>" });
    res.locals.token = token;
    // Anything the operation writes without naming an actor is still the token's (D-032).
    runAs(token.actor, next);
  };
  const json = express.json({ limit: "5mb" });
  const raw = express.raw({ type: () => true, limit: 200 * 1024 * 1024 });

  for (const o of ops) {
    const path = o.path.replace(/\{(\w+)\}/g, ":$1");
    r[o.method](path, auth, o.multipart ? raw : json, async (req, res, next) => {
      try {
        const token = res.locals.token as ApiToken;
        if (!allows(token, o.scope))
          return void res.status(403).json({ error: `This token lacks the "${o.scope}" scope` });
        const files: Record<string, FilePart> = {};
        let body: unknown = req.body;
        if (o.multipart) {
          const form = await readForm(req);
          for (const [name, spec] of Object.entries(o.multipart.files)) {
            const v = form.get(name);
            if (v instanceof File)
              files[name] = {
                data: Buffer.from(await v.arrayBuffer()),
                filename: v.name,
                type: v.type || "application/octet-stream",
              };
            else if (spec.required) throw new BurrowError(`Missing file part "${name}"`);
          }
          const meta = form.get("meta");
          body = o.multipart.meta.parse(typeof meta === "string" && meta.trim() ? JSON.parse(meta) : {});
        } else if (o.body) body = o.body.parse(req.body ?? {});
        const before = writes(o.scope) ? lastSeq(deps.store) : 0;
        const out = (await o.run({
          params: o.params ? o.params.parse(req.params) : req.params,
          query: o.query ? o.query.parse(req.query) : req.query,
          body,
          files,
          token,
          actor: token.actor,
          req,
        })) as Record<string, unknown>;
        res
          .status(o.status ?? 200)
          .json(writes(o.scope) ? { ...out, events: deps.store.events({ after: before, limit: 500 }) } : out);
      } catch (e) {
        next(e);
      }
    });
  }
  return r;
}

const lastSeq = (store: Store) =>
  Number((store.db.prepare("select coalesce(max(seq), 0) n from events").get() as { n: number }).n);

async function readForm(req: Request): Promise<FormData> {
  const type = req.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data")) throw new BurrowError("Send multipart/form-data", 415);
  if (!Buffer.isBuffer(req.body)) throw new BurrowError("Empty request");
  try {
    return await new Response(new Uint8Array(req.body), { headers: { "content-type": type } }).formData();
  } catch {
    throw new BurrowError("Couldn't read the multipart body");
  }
}

// ------------------------------------------------------------------ OpenAPI

const clean = (s: Record<string, unknown>) => {
  const { $schema: _s, $id: _i, ...rest } = s;
  return tidy(rest) as Record<string, unknown>;
};
/** Drop zod's "any safe integer" bounds: noise in docs. */
function tidy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tidy);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (
      (k === "minimum" && x === Number.MIN_SAFE_INTEGER) ||
      (k === "maximum" && x === Number.MAX_SAFE_INTEGER)
    )
      continue;
    out[k] = tidy(x);
  }
  return out;
}
/** One schema, with shared parts as refs to the components (zod puts them in $defs). */
const toSchema = (s: z.ZodType, io: "input" | "output") => {
  const { $defs: _d, ...js } = clean(
    z.toJSONSchema(s, { io, unrepresentable: "any" }) as Record<string, unknown>,
  );
  return JSON.parse(JSON.stringify(js).replaceAll('"#/$defs/', '"#/components/schemas/')) as Record<
    string,
    unknown
  >;
};

/** A JSON body; its first schema example doubles as the media type's example (what doc viewers show). */
const jsonBody = (schema: Record<string, unknown>) =>
  Array.isArray(schema.examples) && schema.examples.length
    ? { schema, example: schema.examples[0] }
    : { schema };

/** Path and query parameters, one per object key. */
function parameters(s: Obj | undefined, where: "path" | "query") {
  if (!s) return [];
  const js = toSchema(s, "input") as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  return Object.entries(js.properties ?? {}).map(([name, schema]) => {
    const { description, ...rest } = schema;
    return {
      name,
      in: where,
      required: where === "path" || (js.required ?? []).includes(name),
      ...(description ? { description } : {}),
      schema: rest,
    };
  });
}

export function openApi(ops: AnyOp[], info: { version: string; server: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  const usedTags = new Set<string>();
  for (const o of ops) {
    usedTags.add(o.tag);
    // Answers may grow new properties: don't promise there are no others.
    const { additionalProperties: _a, ...response } = toSchema(o.response, "output") as {
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: unknown;
    };
    if (writes(o.scope)) {
      response.properties.events = {
        type: "array",
        items: { $ref: "#/components/schemas/Event" },
        description: "Events this request appended, oldest first (attributed to the token's actor).",
      };
      response.required = [...(response.required ?? []), "events"];
    }
    const body = o.multipart
      ? {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  ...Object.fromEntries(
                    Object.entries(o.multipart.files).map(([k, f]) => [
                      k,
                      { type: "string", format: "binary", description: f.description },
                    ]),
                  ),
                  meta: { ...toSchema(o.multipart.meta, "input"), description: "JSON, as a text part." },
                },
                required: Object.entries(o.multipart.files)
                  .filter(([, f]) => f.required)
                  .map(([k]) => k),
              },
              encoding: { meta: { contentType: "application/json" } },
            },
          },
        }
      : o.body
        ? { required: true, content: { "application/json": jsonBody(toSchema(o.body, "input")) } }
        : undefined;
    const err = (d: string) => ({
      description: d,
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    });
    (paths[o.path] ??= {})[o.method] = {
      operationId: o.id,
      tags: [o.tag],
      summary: o.summary,
      ...(o.description ? { description: o.description } : {}),
      "x-scope": o.scope,
      security: [{ token: [o.scope] }],
      parameters: [...parameters(o.params, "path"), ...parameters(o.query, "query")],
      ...(body ? { requestBody: body } : {}),
      responses: {
        [String(o.status ?? 200)]: {
          description: "OK",
          content: { "application/json": { schema: response } },
        },
        "400": err("Invalid request (see `issues`) or a rule the core enforces."),
        "401": err("No token, or an unknown or revoked one."),
        "403": err(`The token lacks the \`${o.scope}\` scope.`),
        ...(o.path.includes("{") ? { "404": err("Not found.") } : {}),
      },
    };
  }
  const all = z.toJSONSchema(z.globalRegistry, {
    io: "output",
    unrepresentable: "any",
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, Record<string, unknown>> };
  return {
    openapi: "3.1.0",
    info: {
      title: "Burrow API",
      version: info.version,
      description: DESCRIPTION,
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: info.server }],
    tags: TAGS.filter((t) => usedTags.has(t.name)),
    paths,
    components: {
      schemas: Object.fromEntries(Object.entries(all.schemas).map(([k, v]) => [k, clean(v)])),
      securitySchemes: {
        token: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "bur_…",
          description: `Make one on Burrow's API page. Scopes: ${SCOPES.map((s) => `\`${s}\` (${SCOPE_INFO[s]})`).join(" ")}`,
        },
      },
    },
  };
}

const DESCRIPTION = `The home graph for outside systems: things, places, tags, links, external refs, assets, schema and history.

**Tokens and attribution.** Every request carries \`Authorization: Bearer <token>\`. A token belongs to one *actor* (e.g. \`pcb-rig\`): every change it makes is an event recorded under that name, shown in Burrow's history and undoable there. Writes answer with the \`events\` they appended.

**Provenance.** Values an app writes are marked \`source: "app"\` unless the request says otherwise (for example \`you\` when a person typed them on the app's screen). Upserts by ref never overwrite a field a person set in Burrow unless asked to (\`keepYours: false\`).

**Syncing.** Link things to your own ids with refs (\`PUT /refs/{service}/{remoteId}\` creates or updates), attach files by your own key (re-uploading the same \`key\` replaces the file), and follow changes with \`GET /events?after=<seq>\`.

**Ids.** Things are \`B-0042\` (the number alone works too), assets \`A-0001\`. Files are served from \`/media/<file>\` on the same host.

**Not here.** paperless documents (Burrow only keeps links) and paid AI calls, which always need a person to see the price first.`;

const TAGS = [
  { name: "Things", description: "Anything Burrow knows: items, places, tags and documents are all things." },
  { name: "Places", description: "Things other things are inside (rooms, furniture, boxes), with paths." },
  { name: "Tags", description: "Tags are things too (kind `tag`), nested under parent tags." },
  { name: "Links", description: "Typed relations between things (accessory of, part of, …)." },
  { name: "Refs", description: "Ties between things and ids in other systems; the way to sync." },
  { name: "Assets", description: "Photos, shop pictures, icons, sprites and 3D models of a thing." },
  {
    name: "Schema",
    description: "Kinds (with typed fields and inheritance) and link types. Schema is data.",
  },
  { name: "History", description: "The append-only event log, with undo." },
  { name: "Token", description: "About the token in use." },
];
