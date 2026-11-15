// One-off, idempotent migration to D-026: the fake room "Nowhere specific" becomes the real
// "no fixed place" state. Its direct contents roam, then the empty room is archived.
// Every change is an event (undoable, survives a rebuild). Back up first: VACUUM INTO.
import { Store } from "@burrow/core";
import { config } from "../config.ts";
import { aiMigrations } from "../ai/gateway.ts";

const ACTOR = "migration";
const NAMES = /^(nowhere( specific| in particular)?|carried|no fixed place)$/i;
const store = Store.open(config.db, aiMigrations);
const report = { rooms: [] as string[], roaming: [] as string[] };

for (const p of store.places()) {
  if (p.depth !== 0 || !NAMES.test(p.name.trim())) continue;
  for (const t of store.list({ parentId: p.id, limit: 500 })) {
    store.move(t.id, null, ACTOR, undefined, null, true);
    report.roaming.push(`${t.id} ${t.name}`);
  }
  if (!store.list({ parentId: p.id, limit: 1 }).length) {
    store.archive(p.id, ACTOR);
    report.rooms.push(`${p.id} ${p.name}`);
  }
}
console.log(JSON.stringify(report, null, 2));
