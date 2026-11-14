# Context: the environment Burrow lives in

Checked 2026-11-14. No secrets here (they are in `.env`).

## Upstream services

| Service                     | Where                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HomeBox v0.27.1             | `http://fedora:3100`               | API key auth (`Authorization: Bearer hb_…`). Items + locations are one "entities" API; the plain `/entities` listing **omits locations**, so they are fetched with `entityTypeIds=<location types>`. Parent is in `parent` on summaries. Custom fields in use: `slug`, `revision`, `width_mm`, `height_mm` (from a PCB photo tool). At first sync: 97 PCBs + 1 item, 8 flat rooms, 73 tags; items mostly unplaced. Swagger: `/swagger/doc.json`. |
| paperless-ngx 3.1 (API v10) | `PAPERLESS_NGX_URL`                | Token auth. ~114 docs, 39 tags, 17 correspondents, 10 document types, no storage paths, 6 custom fields. No inbox tag configured (a tag named `inbox` exists with 0 docs); ~4 docs have neither correspondent nor type. `fields=` allowlisting works (verified: only the requested keys come back).                                                                                                                                              |
| LM Studio                   | `LLM_STUDIO_URL` (host `worky`)    | OpenAI-compatible `/v1/chat/completions` with `response_format: json_schema`; `/api/v0/models` shows load state. `google/gemma-4-31b` (VLM, 262k ctx) is loaded.                                                                                                                                                                                                                                                                                 |
| ollama                      | `http://fedora:11434`              | Installed: qwen3.5:9b, gemma4:e4b, qwen3, gemma3 (1b/4b/latest), deepseek-r1, nomic-embed-text. Nothing loaded by default. Same box as the other services: be gentle.                                                                                                                                                                                                                                                                            |
| Anthropic API               | `ANTROPIC_API_KEY` (sic)           | Both spellings accepted. Key was invalid (401) early on 2026-11-14, fixed the same day. Prices in `apps/server/src/ai/pricing.ts`.                                                                                                                                                                                                                                                                                                    |
| Telegram bot                | `TG_BOT_TOKEN`, `TG_ADMIN_CHAT_ID` | In `.env`, unused so far (ideas: notifications, "add by photo" from the phone).                                                                                                                                                                                                                                                                                                                                                                  |

## Machines

- `fedora`: the home server (HomeBox, ollama, Burrow dev). Dev UI: `http://fedora:5180`.
- `worky`: runs LM Studio with the big GPU model.
- Another local app already uses port 5173 (a PCB photo tool), hence Burrow web on 5180.

## The brainstorm

Design canvas "Burrow — home inventory brainstorm" (claude.ai artifact, private). Treated as a
first brainstorm, not a spec. The useful bits are distilled into `ideas.md` and `decisions.md`.
