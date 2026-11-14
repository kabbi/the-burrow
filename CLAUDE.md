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
- HomeBox is read-only from Burrow (`HOMEBOX_WRITE=0`) until write-back is agreed on.
- All writes to the core go through `Store` methods (they append events). Never `UPDATE` projection
  tables directly.

## Conventions

- TypeScript run natively by Node 24 (type stripping): relative imports use `.ts` extensions, no
  enums/namespaces/parameter properties (`erasableSyntaxOnly`).
- pnpm workspace; oxlint + oxfmt; vitest. Run `pnpm check` before committing.
- Web dev server: port 5180 (5173 belongs to another local app). Browser testing: agent-browser.
- Commit in small steps with descriptive messages.
