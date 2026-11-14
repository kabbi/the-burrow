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
