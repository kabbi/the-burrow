# Architecture

```
            ┌──────────── apps/web (Vite + React) ────────────┐
            │ Find · Add · Thing · Papers · Needs details · AI│
            └───────────────┬─────────────────────────────────┘
                            │ /api (JSON)
┌───────────────────────────▼──────────────────────────────────────┐
│ apps/server (Express 5)                                          │
│  routes/things  routes/papers  routes/ai  /homebox/*  /overview  │
│        │              │            │                             │
│        │      adapters/paperless   ai/gateway ── providers ──────┼──► Anthropic API (paid, quoted)
│        │      (metadata only)      (quote→run)  lmstudio/ollama ─┼──► LM Studio @ worky, ollama @ fedora
│        │              │                                          │
│  adapters/homebox ────┼──────────────────────────────────────────┼──► HomeBox (read-only pull)
│        │              └──────────────────────────────────────────┼──► paperless-ngx
│  packages/core: Store ──► data/burrow.sqlite                     │
└──────────────────────────────────────────────────────────────────┘
```

## Core (`packages/core`)

A small, generic **home graph** on `node:sqlite` (Node's built-in SQLite, FTS5 included, no native
build). It knows nothing about inventory beyond a few seed kinds.

- **`events`**: append-only log, the source of truth. Every write is an event (`thing.created`,
  `thing.changed`, `thing.moved`, `thing.status`, `thing.confirmed`, `thing.archived`, `ref.linked`,
  `edge.added`, `kind.defined`, …).
- **Projections**, rebuilt by `Store.rebuild()` from the log:
  - `things`: id, kind, name, `data` (JSON own fields), `meta` (per-field provenance), `parent_id`
    (the single physical "inside" parent), status, timestamps.
  - `edges`: typed links that aren't "inside" (`documents` → `paperless:<id>`, later `on_board`, …).
  - `external_refs`: thing ↔ service + remote id (HomeBox uuid + asset id, …).
  - `kinds`: field definitions as data (add "plant" without code).
  - `things_fts`: FTS5 over name / body (description, tags, maker, refs, id) / path.
- **Undo** never rewrites history: `toggleUndo(seq)` appends the inverse event (`undo_of = seq`);
  undoing an undo is redo. Inverses are computed against the current state, and field provenance is
  restored too.
- **Rules** enforced on append: one parent (it's a column), no loops, known kinds, non-empty names.
- **Gaps** (Needs details) are derived: no place, or a kind's `wanted` field is empty.

Every field carries provenance (`meta[field].source` = you | ai | page | homebox | paperless | …).
The UI colours AI guesses violet until a person confirms them, and the HomeBox sync only updates
fields HomeBox still owns.

## Server (`apps/server`)

- `config.ts`: env only (root `.env`, loaded with `node --env-file`).
- `adapters/homebox.ts`: HomeBox v0.27 "entities" API. `syncFromHomeBox` pulls items and locations,
  maps entity types to kinds, keeps parents, links refs, and is idempotent.
- `adapters/paperless.ts`: inbox, taxonomy, the doc's paperless suggestions, PATCH to file, thumbnail
  proxy. Strict `fields=` allowlist (D-006). `paperless-mock.ts` is a fake for UI work.
- `ai/`: `AiGateway` with registered **tasks** (prompt builder + zod schema), providers
  (Anthropic via SDK structured outputs + server-side fallback; LM Studio and ollama with a JSON
  schema), price table, `ai_requests` log (D-007).
- `link-preview.ts`: OpenGraph / JSON-LD product reading (free, no AI).
- `routes/*`: thin HTTP layer; zod validates input; errors map to status codes in `app.ts`.

## Web (`apps/web`)

React 19, React Router 7, TanStack Query (invalidate-all after writes: the data set is small), plain
CSS with tokens in `styles.css`. Self-hosted fonts (Inter, Space Grotesk).

- `ThingCard`: the one item card (picture, name, one status line, path, actions; "It's not here"
  always available).
- `PlacePicker`: type-to-filter over full paths, create a place inline (inside the selected one).
- `AiSuggest`: quote → show price → run → apply (accepted by default) → violet facts.
- `Facts`: every field with provenance, inline edit, Right / Wrong on AI guesses.
- Toasts carry Undo for 10 s; every change is also undoable from history.
