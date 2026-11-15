# Decisions

Newest at the bottom. Each entry: what, why, what it costs us. Revisit freely, but write down why.

## D-001 · Stack: TypeScript everywhere, pnpm monorepo (2026-11-14)

React 19 + Vite + React Router + TanStack Query on the web; Express 5 + zod on the server; vitest;
oxlint + oxfmt. The owner's usual stack, and nothing here needs anything more exotic. The server runs
`.ts` directly through Node 24 type stripping (no build step, no tsx), so code must stay
"erasable" TypeScript.

## D-002 · Storage: node:sqlite, event log first (2026-11-14)

Node's built-in `node:sqlite` (SQLite 3.50, FTS5, JSON1) avoids native modules. It still prints an
"experimental" warning, which we silence with `--disable-warning=ExperimentalWarning`. If it ever
bites, `better-sqlite3` has a near-identical sync API.

The `events` table is the source of truth and the other tables are projections (from the
brainstorm: "history from day one; adding it later hurts"). The physical "inside" relation is a
`parent_id` column, not an edge row: exactly one parent is then enforced by the schema, and
ancestor queries are a simple recursive CTE. Other relations are rows in `edges`.

## D-003 · IDs: `B-` + zero-padded sequence (2026-11-14)

`B-0042`. Short enough to read aloud, type on a phone, print on a 12 mm label, and fit trivially in
a UHF tag EPC or a tiny QR. Sequential, not random: a home has one server, so there's no
coordination problem, and enumerable IDs don't matter here. The parser accepts `b42`, `0042`, `42`.
HomeBox asset IDs (`000-024`) are kept on the external ref and are searchable.
Considered: ULID / UUID (unreadable), Crockford base32 random (no real benefit at this scale). Maybe
later: a check digit for hand-typed IDs (ideas.md).

## D-004 · HomeBox and paperless are systems of record; Burrow pulls (2026-11-14) — superseded for HomeBox by D-010

Burrow owns what nobody else has: the ID registry, links, provenance, history, boards. Items and
photos live in HomeBox, documents in paperless. For now the HomeBox sync is **pull only**, with
per-field ownership: a field last written by HomeBox is refreshed, and a field someone changed in
Burrow is kept. Write-back (`HOMEBOX_WRITE=1`) is a later step that needs a conflict story.

## D-005 · Places are things (2026-11-14)

Rooms, furniture, boxes are things whose kind has `isPlace`. HomeBox v0.27 made the same move
(items and locations became "entities"). Anything can still contain anything (a case "inside" a
phone); `isPlace` only drives pickers and gaps.

## D-006 · paperless: metadata only, never content (2026-11-14)

The owner's documents are confidential. Burrow reads titles, dates, tags, correspondents, types and
page counts, always through an explicit `fields=` allowlist, so the `content` field is never even
returned. paperless' own `/suggestions/` (its local classifier) is used, but its `dates` field is
dropped because it is extracted from the text. Thumbnails are proxied to the browser only. Any
future AI over document text must use a local model (the gateway enforces `confidential` tasks →
local only).
Inbox = documents with an inbox tag (paperless' `is_inbox_tag`, or names in `PAPERLESS_INBOX_TAGS`,
default `inbox`) **plus** documents with no correspondent and no type. The owner's paperless has no
inbox tag configured, so "untriaged" is what actually fills it.

## D-007 · AI: always quoted, local by default (2026-11-14)

Every AI call is two steps. **Quote** builds the prompt and counts tokens (Anthropic's free
`count_tokens`; ~3.5 chars/token for local models) and stores the price estimate plus a worst-case
ceiling (`max_tokens`). **Run** only happens when the person presses the button that shows the price
(or the ceiling is under `AI_AUTO_APPROVE_USD`, default 0). Each quote runs at most once and
expires after 15 min. The actual cost is logged from `usage`.
Default model in the UI: the already-loaded LM Studio model (free, local). Anthropic default is
`claude-opus-5-5` (effort `low`, structured outputs, server-side fallback to `claude-opus-4-8` on
refusals); Sonnet and Haiku 5.5 can be picked.
Local providers are shared GPU machines: only already-loaded/installed models are offered, Burrow
never pulls or loads models, requests are serialised, ollama gets `keep_alive: 2m`.
AI output is "accepted by default" (brainstorm rule): it is applied immediately with `source: ai`,
shown violet, and each line has Right / Wrong. Fields a person set are never overwritten.

## D-008 · UI: one app, lenses as routes (2026-11-14)

From the brainstorm's "Approach A + a bit of C": one web app (a PWA later), screens as routes, a
shared item card and colour code across screens. Search-first home ("Where's my…") with a small
dashboard under it, since search is the most common question.

## D-009 · Built-in database browser instead of an external tool (2026-11-14)

`/db` in the app: tables with row counts and their role (log / derived / index / meta), paging,
search across columns, sort, a cell editor (JSON pretty-printed, NULL toggle), row delete, a SQL
console (reads by default; writes need an explicit "allow writes" tick), and "Rebuild from events".
It uses the server's own connection, so edits show up in the app immediately, and nothing extra has
to run. sqlite-web / Datasette were the alternatives (to run alongside via `uvx`). Not used for now:
an extra process and a third-party download. Easy to add later if the built-in one falls short.
Caveat shown in the UI: tables derived from the log lose direct edits on rebuild. Lasting fixes go
through the app or the `events` table. Turn off with `BURROW_DB_ADMIN=0`. There is no auth: Burrow
is a LAN app for now (ideas: auth before exposing it beyond the LAN).

## D-010 · Burrow is the system of record for physical things; HomeBox dropped (2026-11-14)

Supersedes D-004 for HomeBox. Two-way sync is expensive (conflicts, echo loops, deletes, schema
mismatch), and once Burrow holds every entity HomeBox adds little. So Burrow implements what we need
itself. A one-time import (`pnpm --filter @burrow/server import:homebox`, read-only and idempotent)
brought over things, tag nesting and photos (into `data/media`, content-addressed, served at
`/media`). The live sync and image proxy are gone. Push-only mirroring can come back later if it
proves useful. HomeBox refs stay on things as history.

## D-011 · paperless stays the source of truth for documents (2026-11-14)

paperless owns the document: file, OCR, title, tags, correspondent. Burrow links to it and enriches
it. A `document` thing (kind `document`, not physical) is created on first link or enrichment
(filing it onto a thing, recording where the paper copy is), never for all documents up front. It
holds the cached title (refreshed when paperless changes it, unless edited in Burrow), the paperless
ref, and our own fields. A paper copy's location is simply its place (e.g. inside a binder
container). There are no HomeBox-style items per sheet of paper. The privacy rules of D-006 still
apply.

## D-012 · Schema as data: kinds, typed fields, relation types (2026-11-14)

The core must be a general system of record for home things, so its schema lives in the event log:

- **Kinds** have `parent` (inherit fields; a child's field overrides a parent's with the same key)
  and two traits: `isPlace` (things go inside it) and `physical` (a missing place is a gap). A
  definition with a built-in id overrides the seed and becomes user-owned.
- **Fields** are typed: text, longtext, number, money, date, boolean, url, select (options), list,
  ref (another thing, optionally of a kind). Declared fields are validated on every write;
  undeclared fields stay free-form, per thing. Removing a field from a kind never deletes values.
- **Relation types**: name + inverse name, allowed kinds on each end (with inheritance), `one` or
  `many`, `symmetric`. Edges are validated against them. "Inside" stays special: the single-parent
  `parent_id` column, with loop checks.
  Edited from the Schema page. Kinds and relation types can't be deleted yet.

## D-013 · Tags are things (2026-11-14)

Our own tag system, meant to outgrow HomeBox's and paperless'. A tag is a thing of kind `tag`
attached by the built-in `tagged` relation. That gives nesting (via the inside relation),
descriptions, aliases, custom fields, renames that apply everywhere, and search through parent tags
for free. The link carries provenance (`data.source`), so AI-suggested tags show violet until kept.
`setTags` takes names and resolves them case-insensitively, aliases included, creating new ones.
paperless tags stay paperless'. The old `data.tags` lists were converted by `migrate:0002`.

## D-014 · Two instances: dev here, production in Docker (2026-11-14)

- **Dev**: `pnpm dev` in this repo, `data/burrow.sqlite`, usually with `PAPERLESS_MOCK=1`, web on :5180.
  Free to break.
- **Production**: the `burrow` container from `~/dev/apps/burrow/docker-compose.yml`, behind traefik
  at `https://burrow.example.com` (direct: `http://fedora:4200`). Real paperless, LM Studio, ollama
  and Anthropic. Data in `~/dev/apps/burrow/data` (DB, `media/`, `backups/`). Its database was
  started fresh from the HomeBox import, not copied from dev, so dev test data never reaches it.
- **Deploy**: `pnpm prod:deploy` (`scripts/deploy.sh`) runs `pnpm check`, builds `burrow:<git sha>`
  (marked `-dirty` with uncommitted changes), takes a `VACUUM INTO` backup of the live DB (keeps 30),
  restarts the stack, and waits until `/api/health` reports the new version. Core migrations run on
  start, so the pre-deploy backup is the rollback path: stop the container, copy the backup over
  `data/burrow.sqlite`, then `docker compose up -d` with the previous image tag.
- Containers can't resolve short hostnames (`fedora` resolves to a link-local IPv6, `worky` not at
  all), so production uses FQDNs (`fedora.example.com`, `worky.<tailnet>.ts.net`).
- No login: `burrow.example.com` resolves to the tailnet address, like the other apps. A tinyauth
  middleware line is ready in the compose file for when tinyauth runs (it isn't deployed today).

## D-015 · Assets: many pictures and models per thing, one cover (2026-11-14)

A thing can have any number of **assets**, each with a role: `photo` (our own, in place), `product`
(shop/marketing photo), `icon` (from an open icon set), `sprite` (stylized 2D art for inventory-style
screens), `model` (3D: `.glb` or `.stl`) and `other`. One of them is the **cover** the UI shows.

- Assets are core data with their own events (`asset.added`, `asset.changed`, `asset.removed`,
  `asset.cover`), all undoable and replayed by `rebuild()`. Projection: `assets` table plus
  `things.cover_id`. Ids are `A-0001` (their own sequence, so item numbers aren't affected).
- **Cover**: the one you chose, else the first that can be drawn in the order photo → product →
  sprite → icon → other → model. `ThingView.cover` carries `fileUrl` / `imageUrl` / `thumbUrl`.
- **Files** stay content-addressed in the media dir (`<sha256[:32]>.<ext>`, written once). Removing
  an asset keeps its file so undo works; a GC can come later. `/media` is served with a strict CSP
  and `nosniff` so an uploaded SVG can't run scripts.
- The server sniffs file types (sharp for images, magic bytes for glb/stl), records the size, and makes
  a 480 px webp thumb for big pictures. **3D posters** are rendered in the browser (three.js) and
  posted back as the model's thumb, because the server has no GPU renderer. A model without a poster
  gets one rendered off-screen the next time its thing is opened.
- Uploads are the raw request body (`POST /things/:id/assets?role=…&filename=…`), not multipart.
  Shop pictures are downloaded (`/assets/from-url`) rather than hot-linked, so they never break.
- **Icons**: Tabler (MIT), Lucide (ISC) and Material Design Icons (Apache-2.0, added 2026-11-15 for
  electronics: LEDs, resistors, chips) bundled as Iconify JSON and searched by name on the server.
  Item names never leave the box. The SVG is stored as a normal asset, with the license in `data`.
- **3D generation**: Stable Fast 3D (`~/dev/tools/stable-fast-3d/server.py`, fedora:8765, CUDA) via
  `SF3D_URL`. Local and free, about 5 s per model. One request at a time from Burrow. The result is a
  `model` asset with `source: ai` and `data.generator` / `data.fromAssetId`.
- The old `data.imageUrl` / `data.thumbUrl` fields were converted by `migrate:0004` (HomeBox photos →
  `photo` assets).

## D-016 · Place hierarchy: spots, Places tree, compact paths (2026-11-14)

"Inside" stays a single parent per thing (the `parent_id` column, loop-checked), so moving a box
moves everything in it as one undoable event. Containers are places: rooms, furniture and boxes are
things with their own B-number.

- **Spot (position)**: optional short free text saying where a thing sits inside its parent ("shelf
  3", "front left"). It belongs to the thing inside and is part of its move: `thing.moved` carries
  `position` / `fromPosition`, and the projection is `things.position`. Moving to another place
  clears it unless you give a new one. Changing only the spot is a move to the same parent, so it has
  history and undo too. Spots are searchable (they're indexed with the path). Suggestions come from
  spots already used in the same place. Shelves only need to be real things if you want to label them.
- **Paths** show spots after the parent: `Living Room › IVAR · shelf 3 › Crate · front left ›
  Modubox`. Cards use a **compact** path (room, "…", last two steps); "…" expands, and the full path
  is in the tooltip. The thing page shows the full path plus a spot editor.
- **Places page** (`/places`, `GET /places/tree`): a tree of all places, sorted by spot then name with
  numbers in order, showing nested and direct item counts. Opening a place lists the things directly
  in it (loaded lazily). Drag a place or a thing onto another place to move it, or onto "take it out"
  to unplace it. Which nodes are open is remembered per browser.

## D-017 · Local AI runs without confirmation (2026-11-14)

Amends D-007. Quotes for local models (LM Studio, ollama) come back with `autoApprove: true`, so
"Suggest details" runs right away. They're free, and waiting for a click added nothing. They are
still quoted and logged in `ai_requests` (tokens, timing, result), and confidential tasks are still
local-only. Anthropic requests still show the price and wait for a yes unless the worst case is
under `AI_AUTO_APPROVE_USD` (0 = always ask).

## D-018 · PCB photos from the rig: both sides, originals, true scale (2026-11-14)

pcb-photo-maker (`~/dev/js/pcb-photo-maker`) shoots each board from both sides at a fixed 20 px/mm,
cropped and flat-fielded, with the bottom mirrored. It wrote to HomeBox, and Burrow's HomeBox import
(D-010) only took each item's main picture (the top).

- **Assets** gain `original` (the untouched camera file, kept next to the processed one) and `key` (a
  stable id from the system that made the asset, unique per thing, e.g. `pcbphoto:<capture id>`).
  An asset's **file can now be replaced** (`asset.changed` with file/mime/bytes/size/data, undoable),
  so a re-shot or reprocessed photo updates in place instead of piling up.
- Rig photos are ordinary `photo` assets with `data.view` (`top`/`bottom`), `pxPerMm`, `widthMm` /
  `heightMm`, `mirrored`, `captureId`, `capturedAt`, calibration and camera file.
- **Backfill** (`import:pcbphoto`, idempotent, read-only on the rig): 191 captures (97 top, 94 bottom)
  matched to things through the HomeBox entity id. The HomeBox top photos were upgraded in place, so
  they stay the covers. All originals kept (≈1 GB with the processed photos).
- **`pcb` kind** (extends Electronics, defined as data): Slug, Revision, Width, Height (mm). The 97
  HomeBox "PCB" entities were moved to it, and `hb_slug`/`hb_revision`/`hb_*_mm` became those fields;
  size comes from the top capture.
- **Both sides** panel on the thing page: Top / Bottom / X-ray (the mirrored bottom over the top, with
  an opacity slider and a 180° turn, since the rig doesn't auto-align rotation yet), and a measure
  tool (two clicks → mm). Links to both originals.
- Next (Part 2, when the rig moves off HomeBox): an API for the rig that upserts things and assets by
  key, resolves place paths, and records the rig as the actor.

## D-019 · Telegram photo bot: add things from a photo (2026-11-14)

Send the bot a photo (or an album: several photos of one thing). After ~7 s it answers
with one menu:

- **🎯 "Looks like your X"** (with where it lives) when one thing clearly matches, else **🆕 the AI's
  name, kind, description and tags**. Up to 3 "already in Burrow?" candidates, shown as a numbered
  contact sheet of their covers.
- Buttons: **📎 add the photo to it** (then ⭐ make it the cover / ↩️ undo), **🔎 show it** (its cover,
  path, link), **➕ new thing** with the AI's details (fields marked AI; the photo becomes the cover),
  **✏️ new, I'll name it** (reply with a name), **✖ discard**.
- After adding: **📍 place** (the AI's guess as a button, never applied by itself; recent places and
  rooms; or reply "IVAR shelf, shelf 3" for a spot), **✏️ rename**, **↩️ undo** (archives it, back to
  the menu).
- Text without a photo searches ("glue gun" → where it is). A caption helps (name, or `B-0042`).

How it matches:

- **By looks first**: `vision.ts` turns pictures into DINOv2-small vectors (24 MB ONNX, pinned HF
  revision, downloaded once into `data/models`) with `onnxruntime-web` (WASM) **on the server's CPU**
  (no GPU box, no cloud). ~0.2 s a picture, cached per media file in `image_vectors`; the new photo
  is compared four ways up (0/90/180/270°). Rig bottoms are indexed un-mirrored. Shown when cosine
  ≥ 0.5; 🎯 needs ≥ 0.85 **and** a 0.04 lead over the runner-up (similar objects shot alike, e.g.
  PCBs on white, all score ~0.9).
- **Then by the AI's words** (`photo-thing` task: the local vision model names the thing and gives
  search words). A name match whose pictures look nothing like the photo is dropped.
- Dropped: a second "is it the same?" AI pass over the candidates (30 s, and text-only recall was the
  real problem).

AI and cost: `photo-thing` runs on LM Studio (gemma-4-31b) with **thinking off** (`noThinking` →
`reasoning_effort: "none"`: ~6-9 s instead of 30-60 s; good enough for a name). Prompts can carry
pictures now (`Prompt.images` = media file names; the gateway loads them as ≤1024 px JPEG at send
time, so `ai_requests` stays small). If the local model is unavailable the bot shows Claude's quoted
price as a button ("🤖 Ask Claude · $0.012") next to "save without AI"; nothing paid runs without
that tap (D-007).

Plumbing: long polling (no public URL needed), plain `fetch` (no bot library). Only chats in
`TG_ADMIN_CHAT_ID` / `TG_ALLOWED_CHAT_IDS` get answers; others are logged with their id. Menu state
lives in `tg_sessions` (survives restarts; buttons keep working). **One process per token**: the bot
runs wherever `TG_BOT_TOKEN` is set unless `TG_BOT=0`; a second poller gets 409 and backs off.
Links use `BURROW_PUBLIC_URL`.

## D-020 · Public API for outside systems: tokens, actors, OpenAPI (2026-11-15)

Outside systems (first: the PCB rig, replacing its HomeBox client) talk to `/api/v1`, a separate,
versioned API. The web app keeps its own unversioned `/api`, which can change with the UI.

- **Tokens** (`api/tokens.ts`, table `api_tokens`): `bur_…` secrets, only a SHA-256 hash stored,
  shown once. Made and revoked on the API page (`/integrations`) or with
  `pnpm --filter @burrow/server token …` (`pnpm prod:token …` in production). Scopes: `read`,
  `write` (includes read), `schema` (kinds and link types). Last use is noted, at most once a minute.
- **Attribution**: each token has an **actor** (`pcb-rig`); every event it causes is recorded under
  that name, so history shows who did what and undo works as usual. Names Burrow writes under itself
  (`you`, `ai`, `import`, `paperless`, …) are reserved. Writes answer with the `events` they
  appended. Apps may undo only their own events.
- **Provenance**: values an app writes get the new field source **`app`** (the event's actor says
  which app) unless the request says `you` (a person typed it on the app's screen) or similar.
  Upserts by ref default to **`keepYours`**: a field a person set in Burrow is not overwritten, and is
  listed in `skipped`.
- **Sync primitives**: `PUT /refs/{service}/{remoteId}` creates or updates the thing linked to the
  caller's id (place by `parentPath`, optionally created; tags replace or add); asset upload is
  multipart (`file`, `original`, `meta` JSON) and re-uploading the same `key` replaces the file in
  place (same asset id, stays the cover); `GET /events?after=<seq>` is a change feed.
- **Self-describing**: one `op({...})` definition per operation (zod for params, query, body and
  answer) drives the route _and_ the OpenAPI 3.1 document at `/api/v1/openapi.json` (public, no
  token). zod 4's own JSON Schema output; shared shapes are components. Readable docs at **`/api/v1`**:
  Redoc's standalone bundle served from our own `node_modules` (no CDN), themed like Burrow. The
  document passes `redocly lint` (only warning: no license, it's private). The API page renders the
  reference from that document; the tests check every answer against its documented schema, so
  docs can't drift.
- Chosen over GraphQL: the core is already REST-ish with zod everywhere, outside systems are simple
  scripts (curl / fetch), and OpenAPI gives client generators without a new runtime dependency.
- **Not exposed**: paperless (only links; `paperless` refs are read-only for apps) and AI (paid calls
  need a person to see the price). The token is not a security boundary for the web app's own `/api`,
  which is still open to the tailnet (D-014); tokens give integrations scoped, attributable access.

## D-021 · Places: Finder-style columns next to the tree (2026-11-15)

Nesting goes deep (room › furniture › box › organiser › compartment), and an indented tree runs out
of width and loses context as it gets deeper. The Places page now has a **Tree / Columns** switch
(remembered per browser).

- **Columns** (Miller columns, like macOS Finder): the first column is the rooms; each next column is
  what's directly inside the place selected before it, sub-places first, then things. Picking a
  thing shows a preview column (cover, kind, spot, tags, Open). Column headers show the place's
  cover, kind and how much is inside, and link to its page. A breadcrumb above jumps back up.
- **Keyboard**: ↑/↓ inside a column, → goes in, ← goes back out, Enter opens the selection
  (double-click too). The selection is in the URL (`/places?at=<place>&item=<thing>`), so a spot can
  be linked to; such a link opens in columns.
- **Moving**: drag a row onto a place row, or onto a column's empty space to put it in that column's
  place (the rooms column = no place). Same drag helpers as the tree (`components/placeDrag.ts`).
- **Filter** in columns lists matching places with where they sit; picking one jumps there.
- Phones: columns are ~80 % of the width and snap, so you see one column with the previous one
  peeking in.
- No new API: the column lists use the same `/places/tree` and `/things?parent=` queries (and cache)
  as the tree.
