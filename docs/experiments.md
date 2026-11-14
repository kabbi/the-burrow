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

**google/gemma-4-31b:** only one data point so far (metal calipers, prompt v2: good description,
4 tags, ~5 s). A full run needs LM Studio to switch models; waiting for the owner's go-ahead.
