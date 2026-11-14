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

## Places (D-016)

- "Inside, including nested" on a place's page: everything deeper, with the path relative to it.
- Quantity split across places (one thing, several stock entries), e.g. 6 LEDs here, 4 there.
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
- Auth (at least for /db and writes) before Burrow is reachable outside the LAN.
- Telegram bot: "where's my…" and "add from photo" from the phone.
