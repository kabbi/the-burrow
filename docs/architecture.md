# Architecture

```
            ┌──────────── apps/web (Vite + React) ────────────┐
            │ Find · Places · Add · Thing · Papers · Needs details · │
            │ Tags · Schema · Database · AI log               │
            └───────────────┬─────────────────────────────────┘
                            │ /api (JSON)
┌───────────────────────────▼──────────────────────────────────────┐
│ apps/server (Express 5)                                          │
│  routes/things  routes/papers  routes/ai  /homebox/*  /overview  │
│        │              │            │                             │
│        │      adapters/paperless   ai/gateway ── providers ──────┼──► Anthropic API (paid, quoted)
│        │      (metadata only)      (quote→run)  lmstudio/ollama ─┼──► LM Studio @ worky, ollama @ fedora
│        │              └──────────────────────────────────────────┼──► paperless-ngx (source of truth for docs)
│  routes/schema · routes/db · routes/assets ── sf3d ──────────────┼──► Stable Fast 3D @ fedora:8765
│  /media (data/media, content-addressed)                          │
│  packages/core: Store ──► data/burrow.sqlite                     │
└──────────────────────────────────────────────────────────────────┘
```

## Core (`packages/core`)

A small, generic **home graph** on `node:sqlite` (Node's built-in SQLite, FTS5 included, no native
build), and the system of record for physical things (D-010). Its schema is data (D-012): kinds
with inheritance and typed fields, relation types, tags as things (D-013).

- **`events`**: append-only log, the source of truth. Every write is an event (`thing.created`,
  `thing.changed`, `thing.moved`, `thing.status`, `thing.confirmed`, `thing.archived`, `ref.linked`,
  `edge.added`, `kind.defined`, …).
- **Projections**, rebuilt by `Store.rebuild()` from the log:
  - `things`: id, kind, name, `data` (JSON own fields), `meta` (per-field provenance), `parent_id`
    (the single physical "inside" parent), `position` (spot inside it, D-016), status, timestamps.
  - `edges`: typed links between things, validated against `relation_types` (`tagged`,
    `has_document`, `accessory_of`, `part_of`, `replaces`, `related`, plus your own).
  - `relation_types`: name / inverse, allowed kinds per end, one-or-many, symmetric.
  - `external_refs`: thing ↔ service + remote id (HomeBox uuid + asset id, …).
  - `assets` (D-015): photos, shop pictures, icons, 2D art, 3D models per thing, with role, file,
    thumb, provenance; `things.cover_id` is the chosen cover (else derived).
  - `kinds`: parent kind, `isPlace`, `physical`, typed fields (add "plant" without code).
  - `things_fts`: FTS5 over name / body (every text field, tag names with their parent tags, refs,
    id) / path. A tag rename or move reindexes everything tagged under it.
- **Undo** never rewrites history: `toggleUndo(seq)` appends the inverse event (`undo_of = seq`);
  undoing an undo is redo. Inverses are computed against the current state, and field provenance is
  restored too.
- **Rules** enforced on append: one parent (it's a column), no loops, known kinds, non-empty names,
  declared field values match their type, links match their relation type (kinds, cardinality).
- **Gaps** (Needs details) are derived: a physical thing with no place, or an empty `wanted` field
  (inherited fields included).
- **Documents** (D-011): thin `document` things linked to paperless by ref; a paper copy's location
  is its place.

Every field carries provenance (`meta[field].source` = you | ai | page | homebox | paperless | …).
The UI colours AI guesses violet until a person confirms them, and the HomeBox sync only updates
fields HomeBox still owns.

## Server (`apps/server`)

- `config.ts`: env only (root `.env`, loaded with `node --env-file`).
- `adapters/homebox.ts` + `scripts/import-homebox.ts`: the one-time HomeBox import (D-010): things,
  tag nesting, photos → `data/media`. Not used at runtime.
- `routes/schema.ts`: kinds, relation types, tags. `routes/db.ts`: the built-in DB browser (D-009).
- `scripts/`: `ai-eval`, `import-homebox`, `migrate-0002` (tags → tag things), `migrate-0004`
  (image fields → assets), `import-pcbphoto` (PCB rig photos + originals, D-018).
- `adapters/paperless.ts`: inbox, taxonomy, the doc's paperless suggestions, PATCH to file, thumbnail
  proxy. Strict `fields=` allowlist (D-006). `paperless-mock.ts` is a fake for UI work.
- `ai/`: `AiGateway` with registered **tasks** (prompt builder + zod schema), providers
  (Anthropic via SDK structured outputs + server-side fallback; LM Studio and ollama with a JSON
  schema), price table, `ai_requests` log (D-007). Prompts may carry pictures (media file names,
  loaded at send time).
- `media.ts`: content-addressed files, type sniffing, thumbnails (sharp). `icons.ts`: bundled
  Tabler/Lucide search. `routes/assets.ts`: upload, from-url, icon, cover, poster, 3D generation via
  `adapters/sf3d.ts` (Stable Fast 3D on the local GPU).
- `link-preview.ts`: OpenGraph / JSON-LD product reading (free, no AI).
- `vision.ts`: "looks like" search: DINOv2-small vectors on the CPU (onnxruntime-web), cached per
  media file in `image_vectors` (D-019).
- `telegram/`: `api.ts` (minimal Bot API client, long polling), `bot.ts` (the photo bot: sessions in
  `tg_sessions`, menus, matching by looks + the `photo-thing` AI task) (D-019).
- `routes/*`: thin HTTP layer; zod validates input; errors map to status codes in `app.ts`.

## Web (`apps/web`)

React 19, React Router 7, TanStack Query (invalidate-all after writes: the data set is small), plain
CSS with tokens in `styles.css`. Self-hosted fonts (Inter, Space Grotesk).

- `ThingCard`: the one item card (picture, name, one status line, path, actions; "It's not here"
  always available).
- `PlacePicker`: type-to-filter over full paths, create a place inline (inside the selected one).
- `AiSuggest`: quote → show price → run → apply (accepted by default) → violet facts.
- `Facts`: the kind's declared fields (typed editors) plus extra per-thing fields, with provenance and
  Right / Wrong on AI guesses.
- `BoardViewer`: both sides of a PCB at true scale (Top / Bottom / X-ray, measure; D-018).
- `Assets`: the pictures & models panel (upload, camera, link, icon picker, Make 3D model, cover).
  `ModelViewer`: three.js, lazy-loaded; also renders posters for models.
- `TagEditor` (chips, autocomplete, create, confirm AI tags), `Relations` (typed links both ways),
  `ThingSearch` (shared finder).
- Pages: Places (tree with counts, drag to move; D-016), Schema (kinds, fields, link types),
  Tags (tree), Database (D-009). `PathView` shows spots and folds long paths on cards.
- Toasts carry Undo for 10 s; every change is also undoable from history.
