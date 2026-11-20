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
- **Icons**: Material Design Icons (Apache-2.0) bundled as Iconify JSON and searched by name and
  alias on the server (D-022).
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

Send the bot a photo (an album was "several photos of one thing" until D-029: now it's a batch). After ~7 s it answers
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
  document passes `redocly lint` (MIT license, D-035). The API page renders the
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

## D-022 · One icon set: Material Design Icons (2026-11-15)

The picker bundled Tabler, Lucide and MDI, and a search like "box" or "plug" returned the same
pictogram three times in slightly different strokes. Now only MDI is bundled: it is the largest
(~7.6k icons), the only one with electronics (LEDs, resistors, chips), and one consistent filled
style. MDI aliases are searched but fold into their real icon, so each picture shows once.
Lost: a few Lucide/Tabler-only shapes (notably `drill`). Icons already picked are unaffected: the
SVG is stored in the asset.

## D-023 · Product links on existing things; the household name vs the product name (2026-11-15)

Things often start as just a name ("my table") and the shop page comes later. Until now only the Add
screen read pages; on a thing's page the Link fact was a plain text field.

- **Two names.** `name` stays what the household calls it ("Dmitry's table"). The new built-in
  Thing field **`productName`** ("Product name") holds the shop's title ("BOLLPOJKE bureau,
  pin/blanc, 90x55 cm"). Both are searched. The thing page shows the product name under the title,
  linked to the page. The Add screen now always keeps the page title as `productName`, even when
  you rename the thing. It's a built-in field (not data) because code fills it.
- **Add product link** (thing page button, or **paste a URL anywhere on the page**; "Re-read link"
  once there is one) and **🔗 paste a product link** under each card on Needs details open the same
  panel (`LinkEnrich`): it reads the page with the free `/preview` (no AI), then lists what would
  change, one row per field (current → page) with checkboxes. Defaults: empty fields and
  unconfirmed guesses (AI, page, HomeBox) are ticked; values you set or confirmed are shown as
  "yours" and unticked; identical values are hidden. The shop picture is ticked unless already kept
  (same source URL); "make it the cover" is ticked only when the current cover isn't a photo or a
  shop picture.
- **One Undo.** `POST /things/:id/from-page` applies the chosen values in one `thing.changed`
  (fields `source: page`, the link itself `you`; `Store.change` now takes per-field `sources`),
  adds the product asset and sets the cover, and answers with every event's seq. The toast's
  Undo reverts them newest first. If the picture fails to download, the fields are still saved.
- **AI follow-up**, ticked by default: after applying, `AiSuggest` starts by itself with the page
  summary (`autoStart`). Local models run right away (D-017); a paid model shows its price and
  waits (D-007). It runs with `keep: ["name"]`, so the AI never renames a thing you named.
- Pages that can't be read (shops that block bots) still let you save the bare link.

## D-024 · "Send to Burrow" bookmarklet for shops that block bots (2026-11-15)

Some shops sit behind anti-bot services (Maisons du Monde: DataDome). The server's `/preview` gets
a 403 no matter the headers: DataDome checks the TLS fingerprint and IP and runs a JS challenge,
and headless Chrome gets a captcha too. Your own browser passes, so it reads the page for us.

- **Bookmarklet** (`SendToBurrow.tsx`, offered next to "Couldn't read that page" when the shop
  blocked us): on the shop page it form-POSTs `location.href` + the head bits (title, meta,
  canonical, JSON-LD, from the live DOM) to `POST /api/capture` in a new tab. A top-level form
  post avoids CORS and cookies. Its target is the origin it was dragged from (dev or production).
- **`/api/capture`** runs the same `parsePreview`, keeps the result in memory (24 h, 200 pages)
  and redirects 303 to `/add?name=<url>`. `/preview` answers from those captures first, so Add,
  "Add product link" and "read again" all see the page.
- **Blocked detection**: `/preview` names the anti-bot (DataDome, Cloudflare challenge,
  PerimeterX, Akamai) from response headers and returns `blocked: true`.

Costs: desktop only (bookmarklets are awkward on phones); captures are lost on restart; anyone on
the network can post a capture (same as the rest of the open `/api`). A shop with a strict CSP
`form-action` would block the post. Shop pictures on a protected CDN may still fail to download.

## D-025 · Thing page: two columns, quieter AI, grouped toasts (2026-11-15)

The thing page was one 890 px column on wide screens: the board viewer and the picture tiles (each
with a role select, × and "Use as cover") took most of the height, the AI box was a big violet
block, ten empty "— add" rows, a full row for "Where in …?", and 15 history rows with Undo buttons.
Confirming five AI guesses stacked five toasts.

- **Layout**: header across the top; then main (board viewer, facts, Inside / Tagged) and a 300–380 px
  side (pictures, links, history). A place shows Inside above its facts. Under 980 px it's one
  column with pictures right after the header (the columns are `display: contents`).
- **Header**: status, path and a small "+ spot" chip on one line (the spot already shows in the path).
- **Pictures**: thumbnails only; ☆/★ on the tile sets or marks the cover; role, cover and remove live
  in the lightbox. Uploads come in as "our photo" (no "upload as" select; change it on the picture).
- **AI**: `AiSuggest compact` is a model picker + "Suggest details" in the facts header; the price box
  opens below only when quoting a paid model. With 2+ unconfirmed guesses an "All right" bar confirms
  them all (one event).
- **Facts**: empty optional fields fold into one "Add: Maker · Link · …" line; wanted fields stay.
- **Toasts**: `useAction(fn, text, { group })` merges rapid similar actions into one toast ("Confirmed
  Maker, Model · removed Price"); its Undo reverts them all, newest first. Used by Right / Wrong and
  tag ✓. `POST /things/:id/confirm` now returns its event, so confirms are undoable from a toast.
- **Links**: the add form opens from "+ link to another thing". **History**: newest 8, "Show all",
  undo as a small link.

## D-026 · "No fixed place": things that travel (2026-11-15)

Laptops, the phone, the Steam Deck, a bag: they have no home spot, and that's fine. Until now the
only ways to say so were "not placed yet" (a gap: it nags in Needs details forever) or a fake room
"Nowhere specific" (counted as a room, shown in pickers, and "Nowhere specific › MacBook" looks like
a real path).

- **Stored as a state of the "inside" relation**, not a place and not a field: `things.roams` (0/1),
  set only with `parent_id = null`. `thing.moved` carries `roams: true` (and `fromRoams` so undo can
  restore it). Moving into any place clears it; moving to nowhere without it means "not placed yet".
  The core rejects `roams` together with a parent.
- **Not a gap**: `gaps` skips "where" for roaming things; `placeTree()` counts `roaming` apart from
  `unplaced`; `list({ roams })` and `GET /things?roams=1` list them.
- **UI word**: "No fixed place" (dashed chip with a bag icon), next to "Not placed yet" (dashed, no
  icon) — two different nowheres. Pickers offer it as the last option; Places shows it as a pseudo
  room. History says "No fixed place now".
- **API**: `roams` on create / upsert / move (`parentId: null, roams: true`) and on every thing.
- **Migration**: `migrate-0005-roams.ts` (`pnpm prod:migrate-roams`) turns the contents of a top-level
  room named "Nowhere specific" (or "Nowhere", "Carried", "No fixed place") into roaming things and
  archives the empty room. Dev had the room with nothing in it.

Considered: a built-in pseudo place thing (a real row with a magic id, would show in counts, paths,
pickers, the API and the FTS path); a kind flag (it's about this laptop, not all electronics); a
`status` value (status is about trusting the location, and a roaming thing can still be missing).

## D-027 · A design system, a new shell and the everyday screens reworked (2026-11-15)

The "Burrow — unified design" canvas settled the look. Until now the web app had tokens in one
1800-line stylesheet and every page styled its own cards, statuses and buttons, so the same idea
(a missing thing, an AI guess, the main action) looked different from page to page.

- **Design system as code**: `src/ui/` holds the tokens, the shared CSS and the React parts (thing
  row, tile, path, the two nowheres, status pill, Right/Wrong, ⋯ menu, move picker, icons). Pages may
  only add layout. Rules and inventory: `docs/design-system.md`; a live sheet drawn with the real
  parts at Workshop › Design system.
- **Rules that changed screens**: fine is silent (the green "Where it should be" dot is gone; only
  exceptions get a pill), one orange per screen (Add in the top bar is outlined; the Papers count and
  "Take photo" stopped being orange; the cover star is ink), counts neutral, toasts bottom left.
- **Shell**: nav is Find · Places · Papers · Tidy up · Workshop. Workshop (`/workshop/*`) holds Kinds &
  fields, Tags, Database, API & tokens, AI log and the design system, with a side nav. Old paths
  (`/later`, `/schema`, `/tags`, `/db`, `/integrations`, `/ai`) redirect. Phones get a bottom tab bar
  (Find, Places, orange +, Tidy, More → sheet) and no top bar.
- **Find**: one question and one box; "When you have a minute" jobs (AI guesses, papers, not placed,
  wanted fields), recently added tiles, "What changed · per thing" (a burst of edits to one thing is
  one entry with one Undo). Pasting a link offers to add it.
- **Search results**: a "Found in …" line when the name doesn't explain the match; Where and Tags
  facets; tags shown as chips; 12+ results of one kind fold into an auto group (opens by itself when
  alone; "Don't group" flattens for this search). Limit raised to 200.
- **Tidy up** (was Needs details, `/tidy`): gaps grouped into jobs with one bulk action each — not
  placed yet (by kind, select by tag, "Put them there" or "No fixed place" for all, one Undo via
  `useBulk`), AI guesses ("All right" per thing), one job per wanted field with an inline input (or a
  product link → LinkEnrich). New `GET /tidy` and `Store.aiUnchecked()` (tags and papers excluded).
- **Add**: big name-or-link box with a Photo button, duplicate check while typing ("You already have
  …" / "It's a second one"), place chips (last place, this session's, rooms) plus "No fixed place" and
  "Not sure yet", kind chips, a stepper, then "Just saved" and "This session" on the side.
- **Thing**: header with a 168 px cover, ID · kind · added by, the path as chips (or a nowhere), status
  pill, tags; Move (orange), It's not here, ⋯ (product link, No fixed place, Archive). Facts use ✓ ✕
  icon buttons; your own values carry no source label. On phones: Back, full-width cover, two big
  buttons.
- **Places**: the two nowheres as dashed pseudo rooms under the tree.

Not done (parked in ideas.md): remembering "Don't group" per kind (Workshop › Groups), duplicate
merging, snoozing a job, grouping by top tag or import, Papers' receipt matching by date. The phone
camera-first Add and the bot were left as they are.

## D-028 · Thing of the day; quieter AI guesses; fewer buttons (2026-11-15)

From the second pass on the design canvas.

- **Thing of the day** (Find, top of the side column; first under the search box on phones): one small,
  useful nudge about one thing. `Store.thingsOfTheDay(day)` returns up to three picks, one per reason:
  _check_ (placed, and nobody moved, found or confirmed its place in 30 days: "Still there?" → confirms
  `parent`, or "It's not here"), _photo_ (no photo of our own: take one right from the card), _field_
  (a wanted field is empty: type it in on the card). Physical things only, never missing ones.
  Picks are an FNV hash of day + id, so they hold all day and change at the viewer's midnight
  (`GET /today?day=YYYY-MM-DD`); "Another one" steps through the three. Done shows a green pill with
  Undo. Nothing is stored: skipping is free.
- **AI guesses**: no violet row background any more. The label is violet with a small filled sparkle,
  the value violet ink, and Right / Wrong are two borderless round icons in a fixed 84 px column.
  "N AI guesses to check · All right" sits in the panel header, replacing the model picker while
  guesses wait.
- **Fewer buttons**: Find's jobs are whole-row links with a chevron (no inner button); activity Undo
  is a quiet link shown on hover; Tidy's AI rows keep only "All right"; the pictures panel folds its
  five add buttons behind one "+ Photo, picture, icon or 3D model" line.

## D-029 · Telegram: an album is a batch of things; no "which place?" prompt (2026-11-15)

Adding a shelf's worth of things one photo at a time, with a menu each, was slow. Now:

- **Several photos at once = several things.** Every photo becomes a new thing straight away, with no
  questions: named "Photo from Telegram" (name and kind marked AI, so they show up as unchecked
  guesses), the photo as its cover. Then, **one photo at a time** (the local model is a shared GPU
  box), the local AI names it, picks a kind, writes a description and tags, all violet until
  confirmed. The look-alike search runs too and leaves the batch's own things out. Only the local model
  runs: when it's away the things keep the placeholder name and the message says why (no Claude: that
  would need a quote per photo, see ideas).
- **One message for the batch**, updated as guesses come in: a numbered list with links, kind, place,
  and 🎯 "looks like your X" when one clearly matches. Fixes:
  - reply **"2 dog nail clipper"** to rename one. Your name wins, and the AI's other **unchecked**
    guesses (description, maker, model, AI tags, kind), made for what it _thought_ it was, are
    redone by the local AI with your name as the caption. They are dropped if the local AI is away.
    Confirmed values and your own stay. The same goes for ✏️ Rename on a single photo.
  - tap a number → that photo's own menu (place, rename, undo; "📎 It's 1: X" when it looks like
    something you have: archives the new thing and adds the photo to X);
  - **📍 All in…** places every new thing of the batch; **🔗 It's all one thing** undoes the batch and
    runs the old one-thing flow with all the photos; **↩️ Undo all** archives them.
  - On the web, the guesses are ordinary AI facts (✓ ✕ on the thing page, Tidy up's AI checks).
- **No "Which place?" prompt.** The place picker used to send a second force-reply message every
  time. Now the picker's own message says "or reply to this message with a place": a reply to the menu
  is the answer (the session's `prompt_id` is the menu itself). Plain text is still search.
- Cost: an album of one thing now takes a tap (🔗) instead of being the default.

## D-030 · AI suggests no tags (paused) (2026-11-15)

AI tag suggestions were wrong about nine times out of ten. Tags in Burrow carry human meaning ("for
the trip", "mum's"), which a name, a photo or a product page can't tell. So the `suggest-thing` and
`photo-thing` tasks no longer ask for tags: the field is gone from the schema and the prompt, which
also saves output tokens and the list of existing tags in the prompt. `applySuggestion` adds none.
Tags a person sets are unchanged. AI tags already in the DB stay violet on the thing page (✓ to keep,
× to remove), and Telegram's rename still drops them. To bring tags back, restore the
field and add a rule like "only reuse an existing tag that clearly applies".

## D-031 · Batch actions on the Tags page (2026-11-15)

Cleaning up tags one page at a time was slow, especially after the AI tags (D-030). The Tags page
now has a checkbox on each tag, "Select the N shown" (after filtering) and "Select the N unused",
and a bar for the selection:

- **Merge into** one of the selected tags (`POST /tags/merge`, `Store.mergeTags`, one transaction):
  things tagged with the others get the target instead (keeping the edge's source, so an AI tag
  stays an unchecked guess), nested tags move under it, the old names and their aliases become its
  aliases (so typing "crafts" still finds "craft"), and the old tags are archived. Merging a parent
  into its own nested tag lifts that tag out first, so nesting can't loop.
- **Nest under** a tag, or move to the top level (existing `move`, one call per tag).
- **Archive**: archived tags drop off every thing.

Each action is one toast with one Undo. The merge endpoint returns every event it appended, and
`useBulk` undoes them newest first.

## D-032 · Accounts: sign-in, attribution, people as things (2026-11-15)

More than one person uses Burrow now, and history should say who did what. No access control
yet: every account may do everything. What accounts give us is a locked door and attribution.

- **People are things** of the built-in kind `person` (not physical; fields: also called, email,
  notes), like tags (D-013). Someone without an account (a child, a guest, grandma) is just a
  person thing. An **account** points at exactly one person thing; the person's name is the
  display name, so renaming the thing renames the account everywhere.
- **Built-in link types to people**: `owned_by` "owned by" / "owns" (many), `bought_by`
  "bought by" / "bought" (one), `authored_by` "author" / "author of" (many). All `toKinds: [person]`,
  so the core refuses anything else. A person's page lists what they own, bought and made, from the
  inverse links. Add more (lent to, gift from) on the Schema page as data. The web link picker
  only offers directions that fit the thing's kind, only searches allowed kinds, and has a "me" chip.
- **Credentials live outside the event log**, in `accounts`, `sessions` and `passkeys`
  (`apps/server/src/auth/accounts.ts`, migration `auth/001`). An append-only log, and the /db
  browser, are the wrong place for password hashes. Passwords: scrypt (N=2^16), 8+ characters,
  5 free tries per username, then a doubling wait up to 15 min. Sessions: a random secret in an
  HttpOnly SameSite=Lax cookie (`Secure` behind traefik; `trust proxy` covers private addresses),
  only its SHA-256 stored, 180 days, sliding. Changing the password signs out your other devices.
- **Passkeys** through `@simplewebauthn/server` + `/browser` v14: discoverable credentials, user
  verification required, so a passkey is a full sign-in without a username. The relying party is
  the host the browser is on (`burrow.example.com`, `localhost`), so a passkey works only on the host
  where it was made, and only on https or localhost (not `http://fedora:5180`). Challenges are kept
  in memory, used once, for 5 min.
- **Attribution**: every event's `actor` is the **username**. The server keeps the request's
  account in an `AsyncLocalStorage` (`auth/context.ts`), and `Store.currentActor` reads it, so a
  store write that names no actor is attributed without passing the account through every route.
  API tokens (D-020) run their operations the same way. Usernames and app actors share one
  namespace (both end up in `events.actor`): neither can take the other's name, or a reserved one
  (`you`, `ai`, `burrow`, `import`, `telegram`, …).
- **Provenance is not the actor.** Field source `you` still means "a person set it", `ai` "a
  guess". Applying an AI suggestion is now the person's event, with values still `ai` (violet).
  Before this, a move's place provenance came from `actor === "you"`; now `move()` writes `source`
  into the event, and undo of a move does too. Old events replay as before.
- **Before accounts**, everything a person did was actor `you`. The log is not rewritten: `you`
  is shown as the **first account** (whoever set Burrow up). `GET /api/accounts` names every actor
  for the UI (people by name and person page, apps, AI, Burrow's own importers).
- **First run**: while there are no accounts, the web app asks for the first one (`/auth/setup`).
  Then signed-in people add others from the account page (`/account`), and the CLI
  (`pnpm --filter @burrow/server account …`, `pnpm prod:account …`) adds accounts and resets
  passwords when nobody can sign in. Disabling an account is CLI only.
- **What's open without signing in**: `/api/health`, the sign-in endpoints, `/api/capture` (the
  bookmarklet's cross-site form POST can't carry a Lax cookie; it only stores a page preview in
  memory), `/api/v1` (its own tokens), and the built web app. `/media` needs a session or an API
  token. Writes with an `Origin` from another host are refused, because SameSite=Lax treats
  `*.example.com` siblings as same-site.
- **Telegram**: each update acts as the account whose Telegram user id matches the sender
  (linked with a code from the account page, D-033). Unlinked chats write as `telegram`.
- `BURROW_AUTH=0` turns sign-in off (everything is `you` again). The existing API tests run that
  way; `test/auth.test.ts` covers sign-in with it on.
- Considered: tinyauth / forward auth at traefik (D-014). It locks the door but can't tell Burrow
  who you are without trusting a header, and passkeys plus per-person history want Burrow to know
  the account itself. Users as a separate table without person things: then "owned by grandma"
  would need a second concept.

## D-033 · Telegram: link your account with a code, no chat ids in config (2026-11-15)

Letting someone use the photo bot meant adding their chat id to `TG_ALLOWED_CHAT_IDS` and
restarting. Now the account page has **Connect Telegram**: it makes a one-time code (8 characters,
no 0/O/1/I, 10 minutes, one per account, in memory) and an "Open @bot in Telegram" button, a
`https://t.me/<bot>?start=<code>` link, so pressing Start sends `/start CODE` by itself. From another
device you can type `/link CODE` instead. The bot links whoever sent a valid code
(`accounts.telegram_id` = their Telegram user id; one Telegram user belongs to one account) and
answers with the help text. The page checks every 3 s and shows "Connected".

- The bot lets in a sender linked to an active account, or a chat from the environment
  (`TG_ADMIN_CHAT_ID`, `TG_ALLOWED_CHAT_IDS` still work, unattributed: actor `telegram`). It runs
  with just `TG_BOT_TOKEN`; it learns its @username with `getMe` for the links.
- The code is the proof that the Telegram account is yours, so the API no longer takes a typed
  Telegram id: `PATCH /api/account` can only unlink (`telegramId: null`). 5 wrong codes from one
  Telegram user pause it for 10 minutes. Disabling an account locks its Telegram out too.
- Strangers get one "private bot: connect it from your account page" reply per chat.

## D-034 · Things you may have twice: a Tidy up job, dismissed with "not the same as" (2026-11-15)

The Telegram bot already asks "Already in Burrow?" for a new photo (D-019, D-029), but nothing
looked at what's already in. Now Tidy up has a job **"N pairs that may be the same thing"**, also
shown under "When you have a minute" on Find. Each pair shows both things (picture, name, place),
why they're offered ("Same name · 91% alike", "Look the same · 97%", "Similar names · 93% alike")
and one button, **Not the same**.

- **Finding pairs** (`apps/server/src/duplicates.ts`), physical things only (tags merge on their
  page, papers and people aren't owned twice). A pair is offered when:
  the names are the same (case, spaces and punctuation ignored), unless both have pictures that
  look nothing alike (< 0.80); or the pictures score ≥ 0.95 on their own; or they score ≥ 0.88 and
  ≥ 35% of the name words match; or one has no picture and ≥ 60% of the name words match.
  Filler words (module, board, clone, kit…) don't count. If both names carry a model number
  (hx711, 6050, rp2040; sizes like 5v or 24ghz don't count) and none match, the pair is skipped
  unless the pictures look the same: ESP32S3 / RP2040 and A4988 / DRV8825 are family, not twins.
  Places pair only with places in the same parent ("Drawer 1" in two cabinets is fine).
- **Looks** come from `ImageIndex.pairs()`: all pairs of already-indexed picture vectors (best
  picture pair per thing pair), no new embedding, cached until the log or the index changes. 194
  pictures take ~30 ms. Rotations aren't tried (the bot's photo search does), and pictures are
  indexed by the bot (at start, and per photo), so a web-added photo counts once it's indexed.
- **Dismissing** is a built-in symmetric link type `not_same` ("not the same as"), so it's an
  event like any other: undoable from the toast, kept by a rebuild, attributed. It is hidden on
  the thing page's links and in its "add a link" picker. **Any** non-tag link between two things
  (accessory of, replaces, related…) also means you know they're two things, so they aren't offered.
- On the dev DB: 10 pairs, of which ~5 are real (ProMicro nRF52840 twice, two INA226, two HX711,
  two boost converters) and the rest close relatives (Lichee RV and its dock, mmWave sensors).
  Good enough for "potential"; the thresholds are constants at the top of the file.
- Not done: **merge** (move pictures, links and papers onto the kept thing, old ID redirects), and
  a regular `vision.refresh()` outside the bot. Both in ideas.md.

## D-035 · Public repo: MIT, no private host names (2026-11-15)

The repo is going public under the MIT license (`LICENSE`, `license` in every package.json and in
the OpenAPI document). Before that, the git history was rewritten (`git filter-branch`) so the
production domain, the tailnet name and the Telegram bot's username never appear in it; the docs
say `burrow.example.com`, `fedora.example.com` and `worky.<tailnet>.ts.net` instead. Commit hashes
from before 2026-11-15 changed, so older production image tags (`burrow:<sha>`) no longer match a
commit.

- Real host names live only in `.env` files: production's `BURROW_PUBLIC_URL` (also read by
  `scripts/deploy.sh` for its "up" line) and dev's `BURROW_DEV_HOSTS` (extra Vite `allowedHosts`).
- Keep it that way: no private domains, tailnet names, bot usernames, tokens or chat ids in
  committed files. LAN machine names (`fedora`, `worky`) and local paths are fine.
- `.claude/` (local agent settings) is ignored.

## D-036 · Stock: split some off, put it back together (2026-11-16)

Three chairs in storage are one thing with `quantity: 3`. Taking one to the bedroom used to mean
moving all three or editing numbers by hand. Now some of a stock can move on its own, and come back.

- **Split makes a real second thing** (`Store.split(id, count, {to, position, roams})`): the
  original keeps the rest, the new thing gets `count` and a copy of the name, kind, fields (with
  their provenance and confirmations), tags, outgoing links (papers, owners, "part of"…, and
  symmetric links), and pictures (new asset rows over the same content-addressed files, the chosen
  cover too; no asset keys, no external refs). Links _pointing at_ the original (its accessories)
  stay with it. Without `to` it stays in the same place and spot. Built-in link `split_from`
  (new → original).
- **Put together** (`Store.combine(fromIds, intoId, {count})`): counts are added up, the others are
  archived with a `merged_into` link (cardinality one). The kept one keeps its name and values and
  fills only empty fields; it gains the others' links and pictures it lacks, links pointing at
  them, and whatever was inside them. Only the same kind. With `count` (one `from`), that many move
  over and both stay ("take one more chair to the bedroom" where one already is).
- **A count of 1 is no count**: `quantity` is cleared when one is left, like the HomeBox import.
- **Family**: `stockFamily(id)` = live things connected by `split_from` / `merged_into`, also
  through archived ones. The duplicates job (D-034) skips pairs in one family (two chairs split off
  the same three aren't linked to each other).
- **Duplicates are not stock.** Two entries of the same physical thing must not add up; combining
  is offered only within a family (the API accepts any same-kind things). See ideas.md.
- Both are composite operations: one transaction, and the answer carries all `events`; the web
  toast's Undo reverts them newest first (`useAction` handles `events`). No new event types.
- **API**: `POST /things/:id/split`, `POST /things/:id/combine`, `GET /things/:id/stock`; the thing
  answer has `stock` and `mergedInto`. Public: `splitThing` (place by id or path) and
  `combineThings`.
- **Web**: Move asks "How many … of N" when there's a quantity (default: all, which is a plain
  move). Picking a place where the same stock already is asks **Put together (×N) / Keep apart**.
  The thing page has a **Same stock · N in all** panel with "Put together here"; the two link types
  are hidden from Links. An archived, combined thing's page redirects to the one that holds it now
  (old labels keep working), with a toast when you came by the old ID.

Considered: one thing with several stock entries (place + count each). It breaks "one parent, a
column" that paths, `Where`, place counts, gaps and the API's `parentPath` all rely on.

## D-037 · A terminal app: `burrow` on the command line and as the web app's terminal mode (2026-11-17)

From the "Burrow TUI" design canvas (Find, Thing, Add, Places, Database, Command palette, Phone,
System). One app in `apps/tui`, two terminals: your own (`burrow`) and a browser tab
(`/terminal`).

- **Stack**: OpenTUI with React, on Bun (`@opentui/core` needs Bun ≥ 1.3.14 or Node ≥ 26.4; the
  repo is on Node 24). Bun comes from npm as a workspace dependency (`bun`, allowed to run its
  postinstall in `pnpm-workspace.yaml`), so `pnpm install` is all a machine or the Docker image
  needs. TanStack Query and invalidate-all after writes, as in the web app.
- **It speaks the web app's own `/api`, signed in as a person**, not `/api/v1` with a token as
  the design suggested: the screens need what only `/api` has (overview, thing detail with history,
  tidy, the DB browser, AI quotes), and per-person history (D-032) should say who did it, not
  "tui". `burrow login` posts to `/auth/login` and keeps the session cookie in
  `~/.config/burrow/tui.json` (mode 600); `BURROW_URL` / `BURROW_SESSION` override it. Events are
  the account's; sessions show the user agent `burrow-tui`.
- **Reuses the web data layer**: `apps/web/src/lib/api.ts` (client + types; its base URL and
  headers are now configurable), `events.ts` (`eventLabel`), `page.ts` (shop pages), `roles.ts`.
  Pure modules only: nothing that imports React DOM.
- **Same binary, scriptable**: no TTY or a command → plain text or `--json` (`find`, `show`,
  `add --in --spot --kind --qty`, `mv`, `lost` / `found`, `undo`, `login`, `whoami`). Places by ID,
  path (`Hall/Shelf`) or a unique name.
- **Web terminal**: the page `/terminal` (outside the normal shell, full screen) draws with
  ghostty-web (Ghostty's VT engine as WASM, inlined in its JS) and opens a WebSocket to
  `/api/tui` on the same server. The server (`apps/server/src/tui.ts`) checks the session cookie
  and that `Origin` is this host (no cross-site WebSocket), then starts `burrow --remote` for that
  tab with a clean environment (`BURROW_URL` = itself, the browser's session, nothing else: no API
  keys or tokens), at most 4 per account. **No PTY**: OpenTUI takes custom streams and a size, so
  keys go to the child's stdin, the screen comes from its stdout, and resizes go as JSON lines on
  fd 3. The design's separate `burrow serve` became this bridge inside the API server, which
  already owns sign-in. Phones get an on-screen key row: esc, tab, a sticky ctrl, ↑ ↓, ⏎, ⌃K.
- **Keys** (System artboard): one layer at a time takes keys (a screen, or a modal on top); keys a
  screen doesn't use reach the global ones (1–8 screens, ⌃K / ? palette, u undo, ⌃R redo, esc
  back, q quit). Text fields are edited by the app itself (`useLine`), so a typed "m" is a letter
  while you type and "move" when you don't. On Find, an empty search box lets 1–8 and ? through.
  The palette lists every command with its key, the current screen's first.
- **Colour + glyph**: ● ok · ▲ heads-up · ✗ wrong · ✦ AI guess; selection is inverse video;
  the focused pane has the bright border. Dark and light themes from the web tokens, picked from
  the terminal's background (OSC 11) or `BURROW_THEME`; `NO_COLOR` gives one ink.
- **Layout by width**: ≥ 140 three columns on a thing, 100–139 list + preview, 60–99 one list
  (tabs as numbers), < 60 phone (two-line rows, "Find ▾"), < 40 × 14 "Make the window a little
  bigger". Fixed rows: tabs, toast line (✓ … u undo · 7s), key hints, and an empty last row
  (rex paints the last row's colours into the window padding; keycaps there would bleed).
- **AI** goes through `AiGateway` like the web's AiSuggest: quote first; a local model runs
  straight away (free, logged), a paid one shows its price and runs only on ⏎. Add starts the
  free local suggestion on its own after a save.
- **Live**: polls the newest event every 4 s and refreshes when it changed (paused while the
  terminal is in the background). SSE is in ideas.md.
- Not done (ideas.md): pictures (kitty / iTerm2 / sixel, half-block fallback), editing DB cells
  as events, per-field review of a pasted shop link (Add reads the page's title, maker and price
  only), the Places tree view, OSC 52 copy in ghostty-web (falls back to showing the text), a
  single compiled binary in releases.

## D-038 · Duplicate: another one of a thing, empty (2026-11-18)

One 3D-printed box is set up (kind, tags, pictures, the model file); a second one comes off the
printer and gets other stuff in it. Split (D-036) doesn't fit: that's one stock counted down, and
a box is one thing that holds things.

- **`Store.duplicate(id, {name, to})`** makes a new thing with the kind, fields (provenance and
  confirmations kept, `quantity` dropped: a copy is one), tags, outgoing and symmetric links
  (papers, owners, "part of"…; not `split_from` / `merged_into` / `copied_from` / `not_same` /
  `replaces`) and pictures (same files, new asset rows, the cover too). **Nothing inside is
  copied**, and links pointing at the original (its accessories) stay with it. It goes into the same
  place without the spot (it's another object), keeps "no fixed place", or goes into `to`.
- **Name**: the next free number among live things of the kind ("Box" → "Box 2", "Box 3" → "Box
  4"), unless one is given. Labels tell them apart anyway; numbers keep search and paths readable.
- **Built-in link `copied_from`** (copy → original, cardinality one), shown in Links ("copied
  from"). Not stock: `stockFamily` ignores it, so nothing offers to put copies together. The
  duplicates job (D-034) treats copies of one thing as known-different (same pictures, near names).
- Physical things only, places included (boxes are places); not tags, papers, people, or archived.
- One transaction, all `events` returned; the web toast's Undo reverts them.
- **API**: `POST /things/:id/duplicate` (`name`, `to`); public `duplicateThing` (place by id or
  path). **Web**: thing page › More › "Duplicate" ("Duplicate (empty)" on places) opens the copy.

Considered: copying the contents too (a kit box with its parts). Not the case at hand, and it'd
mean duplicating many things; it can be an option later.

## D-039 · Kinds are for fields and behaviour; categories are tags (2026-11-20)

The seed kinds Appliance, Tool and "Electronics / PCB" came from HomeBox's entity types, not a
rule, and it showed in prod: a MacBook was an appliance, a printer "electronics", a 3D printer a
tool, and a soldering iron could be any of them. Two of the three had no fields at all.

- **A kind earns its place** by changing what a thing is in Burrow: its fields (Plant: watering),
  or its traits (`isPlace`, `physical`). A subject ("tools", "kitchen", "electronics") is a tag,
  because tags can overlap and a thing has one kind.
- **Device** (`device`, replaces `appliance`, same fields: maker, model, serial wanted; warranty):
  anything with a plug or a battery. Kettle, laptop, printer, soldering iron, 3D printer.
- **Component** (`component`, replaces `electronics`; value, package): parts kept as stock, counted
  with quantity. **PCB** now extends Thing directly: a board isn't a part from a drawer.
- **Tool** is gone: former tools are plain things tagged `tool` (or devices, when they plug in).
- **Furniture vs Container**: furniture stays put in a room; a container can be carried, even full.
- **Removing kinds**: `Store.removeKind` / `kind.removed`, only when no thing (archived ones too),
  child kind or link type uses it; thing, tag, person, document, room and container are kept. A
  removed seed kind isn't seeded again (unless defined again, which makes it the person's own).
- **Migration** `migrate-0006-kinds.ts` (`pnpm prod:migrate-kinds`, `--dry-run`, `--as device=IDs`
  to override per thing): re-kinds through `Store.change` keeping the kind's provenance, tags
  former tools, re-parents PCB, then removes the three kinds. Idempotent; backs up first.
