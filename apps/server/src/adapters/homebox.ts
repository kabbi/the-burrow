import type { FieldSource, Store, ThingView } from "@burrow/core";
import { getJson, UpstreamError } from "./http.ts";

// HomeBox v0.27+ merged items and locations into one "entities" API.
// Swagger: <homebox>/swagger/index.html

export interface HbTag {
  id: string;
  name: string;
  parentId?: string;
}
export interface HbEntityType {
  id: string;
  name: string;
  isLocation: boolean;
  icon?: string;
}
export interface HbEntitySummary {
  id: string;
  assetId: string;
  name: string;
  description: string;
  quantity: number;
  archived: boolean;
  purchasePrice: number;
  entityType: HbEntityType;
  tags: HbTag[];
  imageId?: string;
  thumbnailId?: string;
  parent?: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
}
export interface HbEntity extends HbEntitySummary {
  manufacturer: string;
  modelNumber: string;
  serialNumber: string;
  notes: string;
  purchaseFrom: string;
  purchaseDate: string;
  warrantyExpires: string;
  fields: { name: string; type: string; textValue: string; numberValue: number; booleanValue: boolean }[];
}

export class HomeBox {
  readonly url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  get configured() {
    return Boolean(this.url && this.token);
  }

  private get<T>(path: string) {
    if (!this.configured) throw new UpstreamError("homebox", 503, "not configured");
    return getJson<T>("homebox", `${this.url}/api/v1${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
  }

  status() {
    return getJson<{ health: boolean; build: { version: string } }>("homebox", `${this.url}/api/v1/status`);
  }

  /** All items AND locations (the plain listing leaves locations out). */
  async entities(): Promise<HbEntitySummary[]> {
    const types = await this.get<HbEntityType[]>("/entity-types");
    const locTypes = types.filter((t) => t.isLocation).map((t) => t.id);
    const byId = new Map<string, HbEntitySummary>();
    const page = async (extra: string) => {
      for (let p = 1; ; p++) {
        const r = await this.get<{ items: HbEntitySummary[]; total: number }>(
          `/entities?page=${p}&pageSize=200${extra}`,
        );
        for (const e of r.items) byId.set(e.id, e);
        if (r.items.length < 200) break;
      }
    };
    await page("");
    if (locTypes.length) await page(locTypes.map((id) => `&entityTypeIds=${id}`).join(""));
    return [...byId.values()];
  }

  tags() {
    return this.get<HbTag[]>("/tags");
  }

  entity(id: string) {
    return this.get<HbEntity>(`/entities/${encodeURIComponent(id)}`);
  }

  /** Streams an attachment (photo / thumbnail). Caller pipes it to the client. */
  async attachment(entityId: string, attachmentId: string): Promise<Response> {
    const res = await fetch(
      `${this.url}/api/v1/entities/${encodeURIComponent(entityId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) throw new UpstreamError("homebox", res.status, `attachment HTTP ${res.status}`);
    return res;
  }

  webUrl(entityId: string) {
    return `${this.url}/item/${entityId}`;
  }
}

// ------------------------------------------------------------------ sync

export interface SyncReport {
  created: number;
  updated: number;
  moved: number;
  unchanged: number;
  total: number;
  errors: string[];
}

const ACTOR = "homebox-sync";
const SOURCE: FieldSource = "homebox";

/** HomeBox entity type → Burrow kind. Unknown types become plain "thing". */
function kindFor(e: HbEntitySummary, hasParent: boolean): string {
  if (e.entityType.isLocation) return hasParent ? "container" : "room";
  const n = e.entityType.name.toLowerCase();
  if (n === "pcb" || n.includes("electronic")) return "electronics";
  if (n.includes("appliance")) return "appliance";
  if (n.includes("tool")) return "tool";
  return "thing";
}

function dataFor(e: HbEntity): Record<string, unknown> {
  const d: Record<string, unknown> = {
    description: e.description || undefined,
    quantity: e.quantity && e.quantity !== 1 ? e.quantity : undefined,
    maker: e.manufacturer || undefined,
    model: e.modelNumber || undefined,
    serial: e.serialNumber || undefined,
    price: e.purchasePrice > 0 ? e.purchasePrice : undefined,
    notes: e.notes || undefined,
    purchaseDate: e.purchaseDate || undefined,
    imageUrl: e.imageId ? `/api/homebox/image/${e.id}/${e.imageId}` : undefined,
    thumbUrl: e.thumbnailId ? `/api/homebox/image/${e.id}/${e.thumbnailId}` : undefined,
  };
  for (const f of e.fields ?? []) {
    const v = f.type === "number" ? f.numberValue : f.type === "boolean" ? f.booleanValue : f.textValue;
    if (v !== "" && v !== null && v !== undefined) d[`hb_${f.name}`] = v;
  }
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
}

/**
 * Pull HomeBox into Burrow. Per-field ownership: a field HomeBox set last is
 * refreshed; a field someone changed in Burrow (source ≠ homebox) is kept.
 * Never writes to HomeBox.
 */
export async function syncFromHomeBox(store: Store, hb: HomeBox): Promise<SyncReport> {
  const report: SyncReport = { created: 0, updated: 0, moved: 0, unchanged: 0, total: 0, errors: [] };
  const list = await hb.entities();
  report.total = list.length;
  const byId = new Map(list.map((e) => [e.id, e]));

  // Parents before children, so every parent exists by the time we need it.
  const depth = (e: HbEntitySummary): number => {
    let d = 0;
    for (let p = e.parent; p && d < 64; p = byId.get(p.id)?.parent) d++;
    return d;
  };
  const ordered = list.filter((e) => !e.archived).toSorted((a, b) => depth(a) - depth(b));

  const burrowIdOf = (hbId: string) => store.findRef("homebox", hbId)?.thingId ?? null;

  for (const s of ordered) {
    try {
      const e = await hb.entity(s.id);
      const parentId = s.parent ? burrowIdOf(s.parent.id) : null;
      const data = dataFor(e);
      const refData = { assetId: e.assetId, entityType: e.entityType.name, updatedAt: e.updatedAt };
      const existing = burrowIdOf(e.id);
      if (!existing) {
        const t = store.createThing(
          { name: e.name, kind: kindFor(e, Boolean(s.parent)), data, parentId, source: SOURCE },
          ACTOR,
        );
        store.link(t.id, "homebox", e.id, refData, ACTOR);
        if (e.tags.length)
          store.setTags(
            t.id,
            e.tags.map((x) => x.name),
            SOURCE,
            ACTOR,
          );
        report.created++;
        continue;
      }
      const t = store.mustGet(existing);
      const before = store.stats().events;
      const patch = ownedPatch(t, e.name.trim(), data);
      if (patch) store.change(t.id, patch, SOURCE, ACTOR);
      if (t.parentId !== parentId && (t.meta.parent?.source ?? SOURCE) !== "you") {
        store.move(t.id, parentId, ACTOR, SOURCE);
        report.moved++;
      }
      const touched = store.stats().events > before;
      if (t.refs.find((r) => r.service === "homebox")?.data.updatedAt !== e.updatedAt)
        store.link(t.id, "homebox", e.id, refData, ACTOR);
      if (touched) report.updated++;
      else report.unchanged++;
    } catch (err) {
      report.errors.push(`${s.name}: ${(err as Error).message}`);
    }
  }
  return report;
}

/** Only fields HomeBox still owns (last written by HomeBox) are updated. */
function ownedPatch(t: ThingView, name: string, data: Record<string, unknown>) {
  const owned = (k: string) => (t.meta[k]?.source ?? SOURCE) === SOURCE;
  const patch: { name?: string; data: Record<string, unknown> } = { data: {} };
  if (owned("name") && t.name !== name) patch.name = name;
  // Tags are relations now (D-013), never a data field.
  const keys = new Set([
    ...Object.keys(data),
    ...Object.keys(t.data).filter((k) => owned(k) && k !== "tags"),
  ]);
  for (const k of keys) {
    if (!owned(k)) continue;
    const next = data[k] ?? null;
    if (JSON.stringify(t.data[k] ?? null) !== JSON.stringify(next)) patch.data[k] = next;
  }
  return patch.name !== undefined || Object.keys(patch.data).length ? patch : null;
}
