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

## Papers

- Link papers to things from the thing page too (search papers by title).
- Configure a real inbox tag in paperless and file faster with keyboard-only flows (j/k, Enter).
- Expiry dates from paperless custom fields (`Expiry date`) → heads-up cards.

## Core / platform

- Check digit on IDs for hand-typed labels (Damm algorithm).
- HomeBox write-back (create items, set the Burrow ID as a custom field), with conflict handling.
- Label printing (QR + ID); HomeBox has a labelmaker endpoint.
- PWA + offline read-only cache for the phone.
- Websocket/SSE live updates when readers start producing events.
- Dark mode (tokens are ready for it).
- Telegram bot: "where's my…" and "add from photo" from the phone.
