# Burrow — notes for agents

Start with `docs/architecture.md` and `docs/decisions.md`. Keep the docs current: when you make a
decision, add a `D-xxx` entry; when you try something, add a dated note to `docs/experiments.md`;
park ideas in `docs/ideas.md`.

## Hard rules

- **paperless document content is confidential.** Never request `content`, files, previews or notes
  from paperless, and never send document text to a cloud model. Document lists always use the
  `fields=` allowlist in `apps/server/src/adapters/paperless.ts`. Use `PAPERLESS_MOCK=1` for UI work
  and browser tests so real titles don't land in screenshots.
- **AI costs money.** Every model call goes through `AiGateway` (quote → run). Never run an Anthropic
  request without showing the person the quoted price first. Local models (LM Studio, ollama) are
  shared GPU boxes: use already-loaded models only, never pull or load models, one request at a time.
- Burrow is the system of record for physical things; HomeBox is retired (D-010). paperless remains
  the source of truth for documents; Burrow only links and enriches (D-011).
- All writes to the core go through `Store` methods (they append events). Never `UPDATE` projection
  tables directly (the /db browser can, but warns: a rebuild discards such edits).
- Schema changes (kinds, fields, link types) are data: use the Schema page / `defineKind` /
  `defineRelation`, not code. Tags are things: `setTags` / `ensureTag`, never a `data.tags` list.
- Testing against the mock paperless writes to the real DB: don't file/link mock docs there.
- Back up the DB with `VACUUM INTO` before any migration script.
- Two instances (D-014): dev = this repo; production = Docker in `~/dev/apps/burrow`
  (burrow.example.com, real data). Ship with `pnpm prod:deploy`; never edit production data while
  testing. Ask before deploying if the user didn't ask for it.

## Conventions

- TypeScript run natively by Node 24 (type stripping): relative imports use `.ts` extensions, no
  enums/namespaces/parameter properties (`erasableSyntaxOnly`).
- pnpm workspace; oxlint + oxfmt; vitest. Run `pnpm check` before committing.
- Web dev server: port 5180 (5173 belongs to another local app). Browser testing: agent-browser.
- Commit in small steps with descriptive messages.
