// One-off, idempotent migration of the real database to D-010..D-013:
//  1. data.tags string lists → tag things + "tagged" relations (provenance kept)
//  2. legacy "documents" edges (thing → "paperless:<id>") are removed (they only came from mock tests)
// Every change is an event, so it shows up in history and survives a rebuild.
import { Store } from "@burrow/core";
import { config } from "../config.ts";
import { aiMigrations } from "../ai/gateway.ts";

const ACTOR = "migration";
const store = Store.open(config.db, aiMigrations);
const report = { taggedThings: 0, tagsCreated: 0, legacyEdges: 0 };

const tagsBefore = store.stats().tags;
const rows = store.db
  .prepare("select id, data, meta from things where json_type(data, '$.tags') = 'array'")
  .all() as { id: string; data: string; meta: string }[];
for (const r of rows) {
  const tags = (JSON.parse(r.data) as { tags: unknown[] }).tags.filter(
    (t): t is string => typeof t === "string",
  );
  const source = (JSON.parse(r.meta) as { tags?: { source?: string } }).tags?.source ?? "import";
  for (const name of tags) {
    const tagId = store.ensureTag(name, ACTOR);
    if (!store.edges({ type: "tagged", fromId: r.id, toId: tagId }).length)
      store.relate("tagged", r.id, tagId, { source }, ACTOR);
  }
  store.change(r.id, { data: { tags: null } }, "import", ACTOR);
  report.taggedThings++;
}
report.tagsCreated = store.stats().tags - tagsBefore;

// The only legacy "documents" edges came from testing against the mock paperless,
// so their ids don't match real documents: remove them rather than convert.
const legacy = store.db.prepare("select from_id, to_id from edges where type = 'documents'").all() as {
  from_id: string;
  to_id: string;
}[];
for (const e of legacy) {
  store.append({ type: "edge.removed", edgeType: "documents", fromId: e.from_id, toId: e.to_id }, ACTOR);
  report.legacyEdges++;
}

console.log(report);
