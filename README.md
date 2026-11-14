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

Production: `pnpm build && pnpm start` (the API serves `apps/web/dist`).

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
