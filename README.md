# Burrow

A DIY home asset manager. Burrow keeps one graph of **things** (items, rooms, shelves, boxes, tags,
documents) on SQLite with full history, and is the system of record for everything physical.
Kinds, fields and link types are data you edit in the app. paperless-ngx stays the source of truth
for documents; Burrow links to them and adds what paperless doesn't know (where the paper copy is).
The web UI is built for the real questions at home: "where's my…", "add this quickly", "file this
paper".

> Status: Nov 2026. Core with schema-as-data, Find/home dashboard, Add, Papers inbox, Tags, Schema,
> Database browser.

## Quick start

```bash
pnpm install
cp .env.example .env        # fill in tokens
pnpm dev                    # API on :4100, web on http://localhost:5180 (also http://fedora:5180)
PAPERLESS_MOCK=1 pnpm dev   # same, with a fake paperless (for UI work)
pnpm --filter @burrow/server import:homebox # one-time HomeBox import (done; idempotent)
```

## Production

Runs in Docker from `~/dev/apps/burrow` at https://burrow.example.com (D-014).

```bash
pnpm prod:deploy           # checks → build burrow:<sha> → back up live DB → restart → health check
SKIP_CHECKS=1 pnpm prod:deploy
pnpm prod:logs             # follow the container logs
pnpm prod:migrate-assets   # one-time: old imageUrl fields → assets (D-015), backs up first
```

Data lives in `~/dev/apps/burrow/data` (`burrow.sqlite`, `media/`, `models/`, `backups/`). Without Docker:
`pnpm build && pnpm start` (the API serves `apps/web/dist`).

## Telegram bot

Send a photo to the bot: it says whether you already have that thing (by looks, on the CPU, plus the
local vision model's guess) and lets you add the photo to it, see where it is, or add it as new
(D-019). Needs `TG_BOT_TOKEN` and `TG_ADMIN_CHAT_ID`; only one Burrow may run the bot (`TG_BOT=0` on
the other).

## API for other systems

`/api/v1` is for outside systems (the PCB rig, scripts): Bearer tokens made on the API page
(`/integrations`), each acting as a named actor that shows up in history (D-020). It describes itself
at `/api/v1/openapi.json` (OpenAPI 3.1); the API page renders the reference.

```sh
curl -H "Authorization: Bearer $BURROW_TOKEN" -X PUT https://burrow.example.com/api/v1/refs/my-app/42 \
  -H 'content-type: application/json' -d '{"name": "ESP32 board", "parentPath": "Workshop / Drawer 3"}'
```

Tokens from the shell: `pnpm --filter @burrow/server token list | create "<name>" <actor> write | revoke <id>`
(production: `pnpm prod:token …`).

## Scripts

| Command          | What it does              |
| ---------------- | ------------------------- |
| `pnpm dev`       | API (node --watch) + Vite |
| `pnpm test`      | vitest (core + server)    |
| `pnpm typecheck` | `tsc` in every package    |
| `pnpm lint`      | oxlint                    |
| `pnpm format`    | oxfmt                     |
| `pnpm check`     | all of the above          |

## Layout

```
packages/core   event log + thing graph on node:sqlite (no deps)
apps/server     Express 5 API, HomeBox / paperless adapters, AI gateway
apps/web        Vite + React 19 UI
docs/           architecture, decisions, context, ideas, experiments
data/           burrow.sqlite + media/ (gitignored; back up both)
```

Read [docs/architecture.md](docs/architecture.md) first, then [docs/decisions.md](docs/decisions.md).
