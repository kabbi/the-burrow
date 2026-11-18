# Experiments log

Dated notes on things tried: what, result, what we kept.

## 2026-11-14 · suggest-thing on local gemma-4-31b (LM Studio)

Input: "metal calipers" (kind Tool, placed in Office › Alex drawer 3).

- **Prompt v1** (short rules): ~410 tokens in, 52 out. Weak answer: `kind: "Tool"` (the label, not
  the id), the description just repeated the name, no tags, `quantity: 1` invented.
- **Prompt v2** (explicit per-field rules + one worked example): name "Metal Calipers", description
  "A precision measuring instrument used to measure the distance between two opposite sides of an
  object.", tags measuring / metal / workshop / precision. Good enough for a free local default.
- Kept as guards in `applySuggestion`: map kind labels to ids, ignore quantity ≤ 1, drop a
  description that equals the name.

## 2026-11-14 · HomeBox import

- The first sync created 98 things, but no rooms: the `/entities` listing leaves out location
  entities. Fixed by also listing `entityTypeIds=<location types>`. Re-sync is a no-op (0 events).
- The "updated" counter was wrong when the patch only differed by whitespace. It now counts
  appended events instead.

## 2026-11-14 · Anthropic

- Quoting (free `count_tokens`) failed with 401: the key in `.env` is invalid. No paid request has
  been made yet; the gateway shows the error in the UI.

## 2026-11-14 · suggest-thing: qwen3.8-27b vs gemma-4-31b (LM Studio)

Eval harness: `pnpm --filter @burrow/server ai:eval lmstudio:<model> …` (8 fixed inputs, real
gateway, local only unless `--allow-paid`). `EVAL_ONLY="a|b"` limits the inputs.

**Plumbing:** with `response_format: json_schema`, LM Studio **drops the connection** for
qwen3.8-27b (curl: HTTP 000). Without it the model works: the answer arrives in `content` and the
thinking in `reasoning_content`. The LM Studio provider now falls back to "schema in the prompt +
extract the JSON + zod-validate" and remembers per model that schema mode fails.

**qwen/qwen3.8-27b (4-bit), prompt v2:**

| input                             | kind        | maker/model            | place   | tags                                             | s   | out tok |
| --------------------------------- | ----------- | ---------------------- | ------- | ------------------------------------------------ | --- | ------- |
| metal calipers                    | tool        | –                      | –       | measuring, metal, precision, workshop            | 24  | 592     |
| moka pot                          | thing       | –                      | –       | coffee, kitchen, cookware                        | 26  | 814     |
| ESP32-CAM AI-Thinker              | electronics | AI-Thinker / ESP32-CAM | –       | camera, microcontroller, wifi, dev-board, sensor | 55  | 1669    |
| 3mm flicker LEDs red white orange | electronics | –                      | –       | led, flicker, red, white, orange                 | 20  | 597     |
| large monstera plant              | thing       | –                      | –       | plant, indoor, decor, foliage                    | 18  | 543     |
| nail clippers                     | tool        | –                      | –       | grooming, personal-care, metal, hand-tool        | 20  | 614     |
| IKEA LAGAN dishwasher             | appliance   | IKEA / LAGAN           | Kitchen | dishwasher, kitchen, cleaning, appliance         | 30  | 921     |
| 2m USB-C cable 100W               | thing       | –                      | –       | usb-c, power, fast-charge, cable, charging       | 32  | 1001    |

- Quality: kinds correct every time; maker/model only when certain; reuses existing HomeBox tags
  (`dev-board`, `microcontroller`, `wifi`); places the dishwasher in the Kitchen; useful
  descriptions. No quick questions asked (the LEDs would have deserved "one thing or 3 variants?").
- Speed: **18–55 s per item**, because it thinks 500–1600 tokens first. Too slow for "suggest while I
  type", fine for a background enrichment pass.
- Flaw found: "moka pot" was the prompt's worked example and qwen copied it word for word. The
  example is now "hot glue gun" (not in the eval set). Re-run: its own description, kind
  `appliance`, placed in Kitchen.

**Head to head (same prompt, both loaded, 2026-11-14 afternoon):**

|             | gemma-4-31b (schema mode)                                                                                              | qwen3.8-27b (prompt mode, thinks)                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| time / item | **3–8 s** (~80–110 out tokens)                                                                                         | 12–45 s (380–1430 out tokens)                                                          |
| kinds       | 6/8 right; once invented `"thing own"`, and once called LEDs `thing`                                                   | 8/8 right                                                                              |
| maker/model | ESP32-CAM, LAGAN ✓                                                                                                     | ESP32-CAM, LAGAN ✓                                                                     |
| places      | Kitchen for moka pot + dishwasher, Bathroom for clippers                                                               | same                                                                                   |
| facts       | generic but correct; one junk tag (`distance-lighting`), wrong tags `display, usb` on ESP32-CAM, qty 3 for "3 colours" | more specific and correct (mentions the ESP32-CAM's OV2640 sensor), no invented values |
| failures    | 1 of 13 runs fell into a repetition loop in schema mode (10 KB of JSON, 140 s) → recovered by the fallback             | none                                                                                   |

Fixes from this run:

- The fallback no longer sticks after any error: only connection-level failures (dropped socket,
  empty body) mark a model as "no schema mode"; other errors fall back for that call only, with a
  console warning.
- Schema-mode attempts are capped at 1,200 output tokens, so a runaway loop dies in seconds.
- The first gemma pass was unfair (one failure flipped the remaining items to prompt mode, where
  gemma also starts thinking). The table uses the clean re-run.

**Takeaway:** gemma is the interactive default (fast, good enough, AI output is violet and
correctable anyway). qwen is better for a background "enrich" pass where 30 s per item doesn't
matter. Idea: let tasks pick a model per role (interactive vs background).

## 2026-11-14 · suggest-thing on Claude Haiku 5.5

Same 8 inputs and prompt. Quoted est $0.0033 (worst case $0.0135); **actual $0.00199** for all 8
(~1,845 in + 110–150 out tokens each). First call 4.9 s (connection set-up), then **1.0–2.1 s**.

- Kinds 8/8 sensible (the cable as `thing`, like qwen's first run), maker/model only for ESP32-CAM and
  LAGAN, same places as the local models (Kitchen, Bathroom).
- Best descriptions of the three: specific and useful ("built-in flicker circuit, giving a
  candle-like glow… sold in red, white and orange variants"; "integrated camera module and microSD
  slot").
- Weak spots: tags stuffed from the existing HomeBox list where they don't fit (`display` on
  ESP32-CAM, `audio` on LEDs, `adapter` on a cable). Gemma did the same. One detail may be invented:
  LAGAN called "freestanding" (IKEA sells LAGAN in both freestanding and integrated versions).

**Overall so far** (8 items): Haiku is the fastest (1–2 s), has the best prose and costs ~$0.00025
per item. qwen is the most careful but takes 12–45 s. gemma is a free 3–8 s default with a few more
slips. The prompt's "reuse existing tags" rule pushes every model to borrow ill-fitting tags; next
prompt iteration: show tags with usage counts and say "only if it truly describes the item".

## 2026-11-14 · Stable Fast 3D from a photo

`server.py` from `~/dev/tools/stable-fast-3d` on fedora (:8765, CUDA). Input: the repo's
`demo_files/examples/axe.png` uploaded as a photo of a dev test thing (B-0182). Background
removal on, 1024 px texture, no remesh: **5.1 s**, 367 KB `.glb` with a good texture. The browser
rendered the poster (three.js, off-screen) and posted it back as the thumb. Real phone photos with
clutter are the next test: rembg should cope, but expect odd backs on single-view guesses.

## 2026-11-14 · Backfilling the PCB rig's library

`import:pcbphoto` on the dev DB: 191 captures → 97 HomeBox top photos upgraded in place plus 94
bottoms added, 191 originals; 97 things → `pcb`. 13.5 s; media dir 1.0 GB. A second run changed
nothing. X-ray on the 1.8" TFT (B-0002): holes and headers line up with no turn. Measuring the full
image width gives 64.2 mm = 58.2 mm board + 2 × 3 mm margin, so the scale holds. Some bottoms
report a different board size than their top (e.g. B-0001: top 26.75 mm wide, bottom 13.5 mm, a
shrink-wrapped board), so Width/Height come from the top capture only.

## 2026-11-14 · Photo → "is it already in Burrow?" (Telegram bot, D-019)

- **Text-only matching fails.** gemma-4-31b read a BSS138 level shifter's "LV/HV" pads as "LU/HU"
  and called it a "Sensor Interface PCB"; full-text search on its words never found B-0004.
- **LM Studio vision**: needs JPEG (rejects webp data URLs). Schema mode with an image loops
  ("owne owne owne…"); prompted JSON is fine. Thinking dominates time: default 32-70 s (700-1600
  reasoning tokens), `reasoning_effort: "low"` is ignored (55-62 s), `"none"` 5-9 s. Names are a bit
  worse without thinking (both are often wrong on small PCBs). Kept: `"none"` for photos.
- **Image vectors.** `@huggingface/transformers` couldn't be installed: pnpm dies unpacking the
  300 MB `onnxruntime-node` ("invalid array length"). Used `onnxruntime-web` (WASM) directly instead.
  The DINOv2 ONNX export only outputs `last_hidden_state`: the first try flattened the whole token
  matrix (everything matched B-0049); the CLS token is right (near-identical 0.96, other board 0.33,
  axe 0.03; int8 ≈ fp32).
- **Retrieval test** (25 random rig captures; query = centre 40 % of the uncropped camera original,
  i.e. not the indexed picture, different framing/rotation; against all 97 boards' photos): CLS
  12/25 top-1, 15/25 top-3; querying 4 rotations 14-16 top-1, 15-21 top-3 (samples differ per
  run); un-mirroring rig bottoms helped a little. Similar boards shot alike score ~0.9 against each
  other, hence the "lead over runner-up" rule for 🎯. Everyday objects should separate far better.
- Speed (6 cores, WASM, 2 threads): ~0.2 s a picture, ~0.8 s a query (4 rotations); indexing the dev
  library (192 pictures + 94 mirrored) ≈ 40 s once. End to end in the bot: ~7 s, mostly the VLM.

## 2026-11-15 · Columns view for Places (D-021)

Tried Finder-style columns on the dev DB (only 4 levels deep: Living Room › IVAR › Crate › Modubox
› LEDs). Feels much better than the tree for drilling down, and the path stays readable at any
depth because older columns scroll off to the left. Gotchas: `scrollIntoView` on the selected row
also scrolls the column strip sideways and cancels the smooth scroll to the newest column, so rows
are kept in view by setting the list's `scrollTop` directly. Headless agent-browser can lag a
second behind the URL on React renders (tab throttling), so keyboard tests are run as an in-page
script with small sleeps. Not yet tried on production's real depth.

## 2026-11-15 · Product link on an existing thing (D-023)

Tested in the browser against a fake shop page served from the scratchpad (OG tags + JSON-LD,
127.0.0.1), on two throwaway things in the dev DB (archived afterwards). Thing page: 6 changes
applied in one go, the shop picture became the cover, then gemma-4-31b (LM Studio) ran by itself and
added description, model and 4 tags, and kept "Dmitry's table" as the name. Re-reading
after setting the maker by hand shows "Ikea (yours)" unticked and the picture as "already kept". On
phones the review rows stack (checkbox | label, value); empty cells and "—" are hidden there.

## 2026-11-15 · Reading a DataDome-protected shop (Maisons du Monde)

- `curl` with Firefox UA + French `Accept-Language`: 403, `x-datadome: protected`.
- Headless Chrome (agent-browser): captcha page, no OpenGraph, no JSON-LD.
- Kept: the bookmarklet (D-024). Checked end to end with agent-browser: it captured title and
  picture from a page into the dev Add screen. Not yet tried on Maisons du Monde itself (headless
  is blocked there); try in a real browser.

## 2026-11-15 · Thing page redesign (D-025)

Checked with agent-browser at 1440 and 390 px on a PCB (board viewer + 2 photos), the asset demo
axe (4 assets), the PCB tag (97 tagged) and B-0108 (AI guesses). Two quick Rights → one toast
"Confirmed name, Description"; its Undo reverted both (meta back to unconfirmed). Grouping only
spans 10 s, so slow clicking still gives separate toasts.

## 2026-11-15 · Design system and screen rework (D-026, D-027)

Checked with agent-browser (mock paperless) at 1440 and 390 px: Find, search ("esp32": 8 rows with
"Found in the description"; "usb": 2 tag chips + 34 PCBs folded into one group), Tidy up (101 not
placed, kind and tag chips, selection), Add, Thing, Places, Papers, every Workshop page, the More
sheet. "No fixed place" end to end on the dev DB: added "Test laptop (roams)" (B-0205) from Add →
listed under Places › No fixed place, not in Tidy up; moved to Attic (roams cleared), toast Undo put
it back to no fixed place. Gotcha: agent-browser's ref click on the Add page's "No fixed place" chip
once didn't register (a JS click did); worth a real-phone check. `node --watch` doesn't restart for
edits in `packages/core` (it's behind a node_modules symlink): touch a server file.
Ran `migrate-0005-roams` on dev: archived the empty "Nowhere specific" room (B-0195).

## 2026-11-15 · Accounts and passkeys (D-032)

Tried on a `VACUUM INTO` copy of the dev DB (server on :4110 serving the built web app, mock
paperless, bot off), so no test accounts reached the dev DB. agent-browser: first-account form →
signed in; old "you" history shows as the first account; added a person without an account
(Grandma); on a thing, "owned by" + "me" and "bought by" Grandma then "me" (cardinality one
replaces); the person page lists "owns" and "bought"; raw `events.actor` is the username. Wrong
password shows "Wrong username or password"; right one signs in. **Passkeys end to end** with
Chrome's CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`, ctap2, internal, resident
key, UV) on `http://localhost`: registered, signed out, signed in with the passkey alone (no
username). Bug found and fixed: after setup the gate kept showing the form (an old `needsSetup:
true` was spread over the new state). Gotcha: in zsh, `A="agent-browser --session x"; $A …`
doesn't word-split, so nothing runs; use a function.
Dev DB backup before the new tables: `data/backups/pre-accounts-2026-11-15.sqlite`.
Follow-up: on the real dev setup (:5180) setup failed with "Cross-origin request refused": Vite's
string proxy shorthand sets `changeOrigin`, so `Host` arrived as `localhost:4100` while `Origin`
was `fedora:5180`. Fixed with `changeOrigin: false` in `vite.config.ts`. The browser test used the
built app on one port, so it never went through the proxy.

## 2026-11-15 · Duplicate pairs from picture vectors and names (D-034)

Measured on a copy of the dev DB (100 things with 194 indexed pictures): DINOv2 all-pairs scores
are squeezed: 138 thing pairs ≥ 0.90, 8 ≥ 0.93, 1 ≥ 0.95 (the two INA226 boards, 0.971). Looks
alone at 0.90 would flag every breakout board, so looks need a similar name below 0.95. The first
cut (≥ 0.88 and 30% shared words) gave 16 pairs with XIAO ESP32S3 / RP2040 and A4988 / DRV8825
among them; the "different model numbers" rule and 35% brought it to 10. Tried in the browser on a
copy (API :4101 with mock paperless, Vite :5181 proxying to it): Find shows the job; Tidy lists the
pairs; Not the same drops the pair and the toast Undo brings it back; layout checked at 390 px.

## 2026-11-16 · Split and put together, in the browser (D-036)

On an empty scratch DB (API :4190, auth off, mock paperless; Vite :5190 with a throwaway config
proxying to it). Chair ×3 in Storage: Move, "How many" 1, Bedroom → 2 stay, B-0004 in the Bedroom,
Same stock panel on both. Moving B-0004 back to Storage asked Put together (×3) / Keep apart; Put
together archived it and the page redirected to B-0003; the toast's Undo (several events) restored
both. Moving 1 of 2 into the Bedroom where one already was gave Bedroom ×2 and no new thing.
Gotcha: the dev server's `--watch` restarts on server edits and owns :4100, so a test server on
the same port silently fails to bind; use other ports. Also don't `pkill -f` a pattern that
matches your own shell's command line.

## 2026-11-17 · The terminal app (D-037)

- OpenTUI 0.9.2 needs Bun ≥ 1.3.14 or Node ≥ 26.4; this machine has Node 24 and no Bun. The `bun`
  npm package (1.4.4) works as a workspace dependency, but pnpm 10 skips its postinstall (the
  binary download) until it's listed in `onlyBuiltDependencies`.
- OpenTUI renders over plain stream objects (a PassThrough with `isTTY` and a no-op `setRawMode`,
  explicit width/height, `remote: true`), so the web terminal needs no PTY. Probe: a React counter
  over PassThroughs; output is diffed frames inside synchronized-output brackets.
- Tested against a `VACUUM INTO` copy of the dev DB (API :4199, mock paperless, no `.env` so no
  bot or paid AI; a test account `tuitest`), Vite :5199 proxying to it (`BURROW_DEV_API`). CLI:
  add with `--in`/`--spot`, mv, undo (history says `tuitest`). Headless frames with
  `test/peek.tsx` for every screen at 150, 120, 80, 48 and 38 columns. Places: marked two unplaced
  PCBs, carried them to the Attic: one toast, "undo 2". WebSocket bridge: wrong Origin → 403, no
  cookie → 401, signed in → the drawn Find screen, typing searches, ⌃C ends the child, no
  processes left. In Chrome (agent-browser): `/terminal` at 1400 px and 390 px (on-screen keys).
- Bugs found on the way: two ↓ before a re-render both moved from the same row (selection now
  uses functional updates, so key repeat doesn't skip); the mock keyboard types `"space"` as five
  letters (use `" "`).

## 2026-11-17 · Upside-down 3D model posters

- STL posters (the cover picture the browser renders for a model) came out flipped vertically
  in Firefox, though the viewer showed the model upright. Not the model: the stored poster is an
  exact top-to-bottom mirror of the right frame (mean pixel difference 0.30 vs ~10 for other
  orientations), and no camera pose makes a mirror. Chrome's capture and sharp were fine.
- First try: `gl.readPixels` on the drawing buffer instead of `canvas.toBlob()`. Still upside down
  in Firefox, so its readback of the canvas's own buffer is flipped either way.
- Fix: the poster frame renders into its own `WebGLRenderTarget` (4× MSAA) and reads that
  back; the code flips rows and un-premultiplies. A float target came out blank in Firefox; an
  8-bit sRGB target (GPU encodes on write) is used instead, and an empty frame uploads nothing.
- Result: right in Chrome, still upside down in the user's Firefox, even read back from the
  render target. So Firefox flips on every readback path tried, or something after it does;
  not found (headless Firefox here has no WebGL). Workaround: make posters in Chrome. A small
  software rasterizer on the server was considered and dropped: posters should look as good as
  the three.js viewer.
- Searched Bugzilla/Reddit: no open bug for it. Old fixed flips were all software WebRender
  (1670139, 1657771, 1808878); the user's Firefox (Apple M1) uses hardware WebRender. Settled on a
  per-browser switch: Workshop › This browser › "Flip 3D model pictures" (localStorage).
- Then rolled back the render-target capture (it didn't help Firefox): the poster is the canvas's
  `toBlob()` again; with the switch on, the canvas is drawn flipped onto a 2D canvas first.
- That was upside down in Firefox with the switch on or off, and the render-target capture with
  the switch on had come out right. So in that Firefox `toBlob` and `readPixels` read top-down,
  but `drawImage` of the WebGL canvas onto a 2D canvas is upright. Posters now always go through
  `drawImage` (upright in Chrome too); the switch stays as a spare that flips the copy.
- A console probe (scissor-clear red on top, then read back) said every readback was FLIPPED in
  Firefox 159 on macOS / Apple M1 (Chrome: all upright). Misleading: that Firefox seems to place
  the scissor rect flipped. Running the real ModelViewer poster code in the user's tab, with the
  switch off and on, settled it: `drawImage` capture with the switch **off** is upright there
  (and in Chrome). The later upside-down posters were made with the switch on.
- Removed the switch (and the Workshop › This browser page): `drawImage` capture is right in both
  browsers tested.
  In Chrome the result matches the on-screen canvas (mean difference 0.03/255), GLB textures
  included. Headless Firefox here has no WebGL, so Firefox needs checking by hand.
- Dev `.env` now has `BURROW_AUTH=0`, so agent-browser can test the dev app without signing in.

## 2026-11-18 · Duplicate in the browser (D-038)

- Dev app, a throwaway container with one thing inside: More › "Duplicate (empty)" made
  "… 2" in the same place, opened it, empty, Links "copied from" the original; the toast had
  Undo. Archived the test things afterwards.

## 2026-11-18 · Photos drawn whole: what fills the gaps

- Thumbnails used `object-fit: cover`, which clipped non-square photos. Switched to `contain`.
- Tried a blurred copy of the photo behind it. In prod it looked muddy: PCBs shot on white paper
  got a greyish average colour instead of white. Also 3D posters are transparent, so the copy
  showed through them (limited to "our photo" / "shop photo" before dropping the idea).
- Now: `ui/edge.ts` samples the photo's edges facing the gaps (48 px canvas, 2 px strips) and
  fills with their per-channel median. If the inter-quartile spread is over 48 (busy edges: a
  hand, a table) it keeps the plain background. Synthetic white/off-white shots blend
  seamlessly; the dev DB's hand-held photos are all "busy" and stay grey.
