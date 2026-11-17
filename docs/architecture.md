# Architecture

```
            ┌──────────── apps/web (Vite + React) ────────────┐
            │ Find · Places · Papers · Tidy up · Add · Thing  │
            │ Workshop: kinds · tags · DB · API · AI · system │
            │ /terminal ── ghostty-web ── WebSocket ──┐       │
            └───────────────┬─────────────────────────┼───────┘
                            │                 apps/tui (Bun, OpenTUI)
                            │                 `burrow` CLI/TUI, or one
                            │                 `burrow --remote` per tab
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
    `has_document`, `accessory_of`, `part_of`, `replaces`, `related`, `not_same`, `split_from`,
    `merged_into`, plus your own).
  - `relation_types`: name / inverse, allowed kinds per end, one-or-many, symmetric.
  - `external_refs`: thing ↔ service + remote id (HomeBox uuid + asset id, …).
  - `assets` (D-015): photos, shop pictures, icons, 2D art, 3D models per thing, with role, file,
    thumb, provenance; `things.cover_id` is the chosen cover (else derived).
  - `kinds`: parent kind, `isPlace`, `physical`, typed fields (add "plant" without code).
    Built-in `person` (D-032): people, with or without an account; linked by `owned_by`,
    `bought_by`, `authored_by`.
  - `things_fts`: FTS5 over name / body (every text field, tag names with their parent tags, refs,
    id) / path. A tag rename or move reindexes everything tagged under it.
- **Undo** never rewrites history: `toggleUndo(seq)` appends the inverse event (`undo_of = seq`);
  undoing an undo is redo. Inverses are computed against the current state, and field provenance is
  restored too.
- **Rules** enforced on append: one parent (it's a column), no loops, known kinds, non-empty names,
  declared field values match their type, links match their relation type (kinds, cardinality).
- **Stock** (D-036): `split` takes some of a quantity out as a new thing, `combine` puts it back
  (archives the rest, `merged_into`); `stockFamily` finds the live relatives.
- **Gaps** (Tidy up) are derived: a physical thing with no place (unless it roams: "no fixed place",
  D-026), or an empty `wanted` field (inherited fields included). `aiUnchecked()` lists unconfirmed AI
  guesses.
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
  Material Design Icons search. `routes/assets.ts`: upload, from-url, icon, cover, poster, 3D generation via
  `adapters/sf3d.ts` (Stable Fast 3D on the local GPU).
- `link-preview.ts`: OpenGraph / JSON-LD product reading (free, no AI). Pages from the
  "Send to Burrow" bookmarklet come in via `POST /capture` and are kept in memory for `/preview` (D-024). `POST /things/:id/from-page`
  (in `routes/assets.ts`) applies chosen page values, the shop picture and the cover (D-023).
- `vision.ts`: "looks like" search: DINOv2-small vectors on the CPU (onnxruntime-web), cached per
  media file in `image_vectors` (D-019).
- `telegram/`: `api.ts` (minimal Bot API client, long polling), `bot.ts` (the photo bot: sessions in
  `tg_sessions`, menus, matching by looks + the `photo-thing` AI task; an album is a batch of
  new things, one session per photo under a batch session) (D-019, D-029). Who may use it: accounts
  linked with a one-time code (`/start CODE` from the account page's t.me link), plus env chat ids
  (D-033).
- `api/` (D-020): the public `/api/v1` for outside systems. `define.ts` (one `op()` per operation →
  route with token auth, scope check and actor attribution, plus the OpenAPI 3.1 document),
  `v1.ts` (the operations), `schemas.ts` (documented answer shapes), `tokens.ts` (`api_tokens`,
  hashed secrets), `docs.ts` (Redoc page at `/api/v1`). `routes/tokens.ts` manages tokens for the web app's API page.
- `auth/` (D-032): `accounts.ts` (accounts → person things, scrypt passwords, cookie sessions,
  passkeys; tables outside the event log), `context.ts` (the request's actor in AsyncLocalStorage,
  read by `Store.currentActor`). `routes/auth.ts`: setup, sign-in (password, passkey), your account,
  the accounts list, and `requireAccount` guarding `/api` (plus same-origin writes). CLI:
  `scripts/account.ts`.
- `routes/*`: thin HTTP layer; zod validates input; errors map to status codes in `app.ts`.

## Web (`apps/web`)

React 19, React Router 7, TanStack Query (invalidate-all after writes: the data set is small), plain
CSS. Self-hosted fonts (Inter, Space Grotesk, JetBrains Mono). The design system (D-027,
`docs/design-system.md`) lives in `src/ui/`: tokens, shared CSS, the thing row / tile / path / status
parts, icons; `styles.css` is page layout only. Shell: top bar on desktop, bottom tab bar + More sheet
on phones (≤ 720 px); Workshop pages share a side nav.

- `ui/thing.tsx`: `ThingRow` (the one item card in list form: picture, name + ID, where, status pill
  only when not fine, actions), `ThingTile` for grids, `Where` (path or one of the two nowheres,
  D-026). `ThingCard` wraps them for older call sites.
- `SignIn.tsx` (D-032): `AuthGate` shows the first-account form or sign-in (password, passkey)
  until someone is signed in; any 401 brings it back. `pages/Account.tsx`: passkeys, password,
  Telegram id, devices, and the household's people. `Who` names an event's actor (people link to
  their person page; `you` from before accounts is the first account).
- `PlacePicker`: type-to-filter over full paths, create a place inline (inside the selected one).
- `AiSuggest`: quote → show price → run → apply (accepted by default) → violet facts. `autoStart`
  quotes on mount; `keep` lists fields it must not change; `compact` fits a panel header.
- `LinkEnrich` (D-023): product link → page preview → per-field review → `from-page` (one Undo) →
  optional AI follow-up. On the thing page (button or paste) and under Needs details cards.
- `Facts`: the kind's declared fields (typed editors) plus extra per-thing fields, with provenance and
  Right / Wrong on AI guesses.
- `BoardViewer`: both sides of a PCB at true scale (Top / Bottom / X-ray, measure; D-018).
- `Assets`: the pictures & models panel (upload, camera, link, icon picker, Make 3D model, ☆ cover);
  role / cover / remove per picture in its lightbox.
  `ModelViewer`: three.js, lazy-loaded; also renders posters for models.
- `TagEditor` (chips, autocomplete, create, confirm AI tags), `Relations` (typed links both ways),
  `ThingSearch` (shared finder).
- API page (`/integrations`): tokens, and the reference rendered from `/api/v1/openapi.json`.
- Pages: Places (tree with counts, drag to move, D-016; or Finder-style columns, D-021), Schema (kinds, fields, link types),
  Tags (tree), Database (D-009). `PathView` shows spots and folds long paths on cards.
- Toasts carry Undo for 10 s; every change is also undoable from history. `useAction`'s `group`
  merges rapid similar actions into one toast whose Undo reverts them all (D-025).
- Thing page (D-025): header, then main (board, facts, inside) + side (pictures, links, history).
- `pages/Terminal.tsx` (D-037): the terminal mode, `/terminal`, full screen: ghostty-web over a
  WebSocket to `/api/tui`, with on-screen keys on phones.

## Terminal app (`apps/tui`, D-037)

OpenTUI + React on Bun (from npm). `burrow` with a terminal and no command is the full-screen app;
with a command (or no terminal) it prints (`find`, `show`, `add`, `mv`, `undo`, `--json`).
`burrow --remote` is the app over pipes for the web terminal (`src/remote.ts`: keys on stdin,
screen on stdout, size as JSON lines on fd 3).

- `api.ts`: the web app's `lib/api.ts` pointed at a server with the session cookie
  (`config.ts`: `burrow login` → `~/.config/burrow/tui.json`; `BURROW_URL`, `BURROW_SESSION`).
- `app/`: `App.tsx` (top bar with tabs, screen, toast line with Undo, key hints, modals, live
  refresh), `keys.tsx` (key layers, the line editor), `state.tsx` (route, `act` = write + toast +
  Undo, move/pick/prompt), `theme.ts`, `ui.tsx` (styled lines, panes, keycaps), `ai.ts` (quote →
  run → apply), `modals.tsx` (⌃K palette, move picker, prompt), `screens/` (Find, Thing, Add,
  Places, Lists = Needs · Tags · Papers · AI log, Db).
- `test/`: `bun test` (helpers, and the app against a fake `/api` drawn headlessly);
  `test/peek.tsx <cols> <rows> keys…` prints a frame from a running server.
- Server side: `apps/server/src/tui.ts` upgrades `/api/tui` (session + same-origin check), one
  `burrow --remote` per tab with a clean environment.
