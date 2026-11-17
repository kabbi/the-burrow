# Ideas & backlog

Loosely ordered. ✓ = done in some form.

## From the brainstorm (first iteration, not a spec)

- ✓ Search-first home: "Where's my…", with a few small cards under it.
- ✓ One item card everywhere: picture, name, one status line, path, then actions; "It's not here"
  always second. Undo after every move (10 s toast, plus history).
- ✓ Colour means one thing: green fine, amber heads-up, red wrong, violet AI guess, orange the one
  main button, black selected.
- ✓ Add rules: save is always allowed (a name alone is a valid thing); Burrow's guesses are accepted
  by default; violet until confirmed; gaps go to Needs details; at most one quick question per add
  (the schema has `question`, the UI doesn't show it yet).
- "It's not here" → offer: I found it (set where), listen for its tag, put on the Missing list / ask
  the other person. Burrow stops trusting that spot.
- Rarity tiers (Common … Legendary): "how much would it hurt to lose this?". Pips, not colour.
  Suggested from price, raised by reason; Legendary is never set by price; containers show "holds
  1 Legendary". `data.tier` is reserved and Common skips Needs details.
- Lenses / skins over the same data: Hoard (game-like inventory, tidy-up as play), Ledger
  (DOS-style keyboard table with batch ops), Bay (wall tablet over a shelf RFID reader).
- Boards: virtual containers (freeform / grid / smart sets), with `on_board` edges carrying x,y.
  "Make it real": a frame becomes a container plus a pick list.
- Places view: rooms, furniture, appliances, cellar boxes; a floor plan with the room highlighted.
- Phone: Seek, tap a tag → item card, add from a photo (snap → guess → saved), wardrobe.
- RFID/UHF: shelf readers, a door reader, a handheld; `tag.seen` events over MQTT; "reader guess"
  until confirmed.
- Enrichment workers: URL → specs/photos/manual PDF into paperless; photo → background removed;
  photo → .glb (stable-fast-3d); 3D file (STL) → container with a bounding box.
- Integrations worth a look: Home Assistant (devices, batteries), Grocy, Spoolman (filament),
  Immich (photos you already took), InvenTree.
- Backups: the SQLite file plus a nightly JSON/CSV export; Datasette over the file for debugging.

## Next up (owner's plan)

1. Iterate on the Add screen UX while the library fills up.
2. Then polish all screens.

## Add screen: things to try

- Photo input: LM Studio's gemma-4-31b is a VLM → snap/drop a photo → identify (local, free).
- Show the AI's `question` as one-tap chips.
- Bulk mode: "a whole drawer" photo → several things.
- Keep the last place across adds (✓) and show recent places as chips.
- Paste a HomeBox / AliExpress / Amazon link → preview (✓ OpenGraph/JSON-LD), then suggest.
- Duplicate detection before saving ("you already have 2 ESP32-CAMs").
- Quantity +/- on an existing thing instead of a duplicate.

## Product links (D-023)

- Telegram: reply to a thing's message with a link → the same fill-in, with ✓ / ↩️ undo.
- Backfill `productName` on things added from a link before D-023 (their name is the shop title;
  production has 2).
- Let the AI suggest a product name too (not just rename) when there's no page, and show
  `productName` on cards when it differs from the name.
- Several shop links per thing (where it was bought vs. the maker's page).
- Plain `createThing` marks `kind` as yours, so the AI never changes the kind of a name-only thing;
  maybe default kind should be `source: you` only when picked.

## AI

- Model per role: fast local model for interactive suggestions (gemma-4-31b), a slower, more
  careful one (qwen3.8-27b) for a background enrich pass over Needs details.
- Tag reuse: every model borrows ill-fitting existing tags (`display` on an ESP32-CAM). Try showing
  tags with counts plus a stricter rule, and score tag fit in the eval.
- Haiku 5.5 as the interactive default once costs are acceptable (~$0.00025/item, 1–2 s).
- Grow the eval set (`ai:eval`) with real items as the library fills, and score answers automatically
  (kind valid, no invented maker, tags reused…).

## Papers

- Link papers to things from the thing page too (search papers by title).
- Configure a real inbox tag in paperless and file faster with keyboard-only flows (j/k, Enter).
- Expiry dates from paperless custom fields (`Expiry date`) → heads-up cards.

## Telegram bot (D-019)

- "Where is it?" with the LED locator (when places get lights): 🔎 Show → blink the shelf.
- Voice notes: "this goes to the garage, top shelf" → place + spot (local whisper).
- Several things in one photo (a drawer): detect objects, one menu per crop.
- Things without photos can't be found by looks: fetch shop pictures for them (from-url) so they can.
- Inline mode (`@bot glue` in any chat) for quick lookups; a daily "things without a place" nudge.
- Batch (D-029) when the local AI is away: one "🤖 Ask Claude for all · $x" button (sum of per-photo quotes).
- Web: renaming an AI-named thing could redo its unchecked guesses too, like the bot does (D-029).
- A batch caption as a shared place ("all in drawer 3"), not only as an AI hint.
- Use the photo's EXIF/time to suggest "the place you were adding things to 5 minutes ago".

## PCB rig (D-018)

- Part 2: switch pcb-photo-maker from HomeBox to `/api/v1` (D-020 has what it needs: `PUT
  /refs/pcbphoto/<item>`, `parentPath`, asset upload by key `pcbphoto:<capture>` with the original).
- Exact 3D board model: outline mask → 1.6 mm slab with the top/bottom photos as textures (`.glb`).
- Search filter "has both sides"; grid hover shows the bottom.
- Auto-align the bottom's rotation (mask IoU over 0/90/180/270) so X-ray needs no 180° toggle.
- Read IC markings from the photos with the local VLM, and make them searchable ("every board with a CH340").

## Places (D-016)

- "Inside, including nested" on a place's page: everything deeper, with the path relative to it.
- Quantity split across places (✓ D-036, as separate things: split / put together). Still open:
  "how many" when dragging a stack on the Places tree (it moves all today), and splitting from the
  Telegram bot.
- Touch drag & drop on the Places tree (HTML5 DnD is desktop-only), or a "move here" mode on phones.
- Print a label sheet for a container and everything in it.

## Assets (D-015)

- Sprite generation: a local image model (ComfyUI / SDXL on the GPU box) that turns a photo or icon
  into stylized 2D inventory art, stored as `sprite` with `source: ai`.
- AI picks an icon: give the model the icon names that match the item's words and let it choose.
- Background removal for our photos (rembg is already in the SF3D env) → clean cut-outs as covers.
- Per-lens cover: the Hoard lens prefers sprite/model, the Ledger lens prefers photo.
- Media GC: delete files no live or removed asset references, after a grace period.
- More 3D formats (`.3mf`, `.obj`), and STL → GLB conversion for printed parts.
- Photo EXIF (date taken) as the "seen here" time for location history.

## Core / platform

- Delete / retire kinds and link types (with a check that nothing uses them), and rename field keys.
- Show HomeBox's extra fields (`hb_slug`, `hb_width_mm`…) as declared fields on Electronics, or
  migrate them to proper keys.
- A dev/test DB (`BURROW_DB`) for mock-paperless UI tests, so they never touch the real data.
- More link types as needed (charger for, lent to, belongs to); smart sets = saved searches.

- Check digit on IDs for hand-typed labels (Damm algorithm).
- (Retired with HomeBox, D-010) HomeBox write-back. Only revisit as a push-only mirror if useful.
- Label printing (QR + ID); HomeBox has a labelmaker endpoint.
- PWA + offline read-only cache for the phone.
- Websocket/SSE live updates when readers start producing events.
- Dark mode (tokens are ready for it).
- (Done: D-032) Sign-in for the web app.

## Accounts and people (D-032)

- Access control: roles (admin / member / guest read-only), at least for /db, Schema and tokens.
- "Mine" filters: things I own, things I added; "who has it" on lent things (a `lent_to` link with
  a date, Tidy up nudges when it's been a while).
- Account admin in the UI: disable, reset someone's password (CLI only today).
- Sign in with a passkey from the username field (conditional UI / autofill).
- Per-person Telegram notifications ("Anna moved your drill").
- Session list with devices and "sign out this one".

## API (D-020)

- Webhooks (push the event feed to a URL) instead of polling `GET /events?after=`.
- "Looks like" search over the API (`POST /match` with a photo → candidates), for other camera apps.
- Token expiry dates and per-token place restrictions (e.g. "only inside Workshop").
- Generate a typed TS client from the spec for pcb-photo-maker (openapi-typescript).
- Telegram bot: "where's my…" and "add from photo" from the phone.

## Product pages (D-024)

- Paid scraping API (ScrapingBee, ZenRows, …) for anti-bot shops from the phone, where the
  bookmarklet doesn't fit. Costs per request: quote it like AI calls.
- Phone: a share target (PWA `share_target`) only gets the URL; would need the paid route above.

## From the design rework (D-027), not built yet

- Workshop › Groups: remember "Don't group <kind>" and the threshold (12) server-side; group by top tag
  or import source too; show groups as dashed pseudo boxes in Places.
- Duplicates (✓ found and dismissable in Tidy up, D-034): a duplicate is the same thing entered
  twice (two photos of one board), so it is **not** a stock combine (D-036 would add the counts).
  Offer "Same thing": keep one, archive the other (or mark it a duplicate), maybe carry over its
  pictures; the old ID points to the kept one. Index web-added photos without waiting
  for the bot (a periodic `vision.refresh()`); try rotations for all-pairs too.
- Snooze a Find job for a week ("Not now").
- Papers: suggest the thing a receipt belongs to by date and shop (titles and dates only, D-006).
- "Tags used once, made by AI" as a Tidy up job with "Remove all".
- Phone Add, camera first: photo → "looks like something you have" (vision search, D-019) → save new.
- Missing since <date> on the status pill (needs the status event time on ThingView).

## Terminal app (D-037), next

- Pictures in the terminal: kitty graphics / iTerm2 / sixel (OpenTUI has kitty image support),
  half-block fallback; the thumbnail via `/media` with the session.
- Database grid: edit a `things` cell as a `thing.changed` event (actor: you), not a raw UPDATE.
- Paste a shop link on a thing → the web's LinkEnrich per-field review; Add only takes the page's
  title, maker, price and picture today.
- SSE on the event log instead of polling `/events?limit=1`.
- Places: the tree view (`t`), and "Open in Places" from a thing.
- Copy (OSC 52) inside ghostty-web, and links (OSC 8) opening in a new tab.
- `bun build --compile` binaries for Linux/macOS, so `burrow` runs without the repo.
- A "Needs" job flow like Tidy up's (one job at a time, with its single action).
