import { describe, expect, it } from "vitest";
import { Store, formatId, parseId, ftsQuery } from "../src/index.ts";

function store() {
  let t = Date.parse("2026-11-14T10:00:00Z");
  return Store.open(":memory:", [], { now: () => new Date((t += 1000)).toISOString() });
}

/** Snapshot of all projections, to compare live state with a replay. */
function snapshot(s: Store) {
  const all = (sql: string) => s.db.prepare(sql).all();
  return {
    things: all("select * from things order by id"),
    edges: all("select type, from_id, to_id, data from edges order by type, from_id, to_id"),
    refs: all("select * from external_refs order by service, remote_id"),
    fts: all("select * from things_fts order by id"),
    kinds: all("select * from kinds order by id"),
  };
}

describe("ids", () => {
  it("formats and parses", () => {
    expect(formatId(42)).toBe("B-0042");
    expect(formatId(12345)).toBe("B-12345");
    for (const s of ["B-0042", "b42", "0042", "42", " b - 42 "]) expect(parseId(s)).toBe(42);
    expect(parseId("hello")).toBeNull();
    expect(parseId("B-0")).toBeNull();
  });
});

describe("Store", () => {
  it("creates things with sequential ids and provenance", () => {
    const s = store();
    const a = s.createThing({ name: "Kitchen", kind: "room" });
    const b = s.createThing({
      name: "Moka pot",
      parentId: a.id,
      data: { tags: ["coffee"], maker: "" },
      source: "ai",
    });
    expect(a.id).toBe("B-0001");
    expect(b.id).toBe("B-0002");
    expect(b.data).toEqual({ tags: ["coffee"] }); // empty values dropped
    expect(b.meta.tags?.source).toBe("ai");
    expect(b.path.map((p) => p.name)).toEqual(["Kitchen"]);
    expect(s.get("2")?.name).toBe("Moka pot");
  });

  it("rejects loops and unknown parents", () => {
    const s = store();
    const room = s.createThing({ name: "Cellar", kind: "room" });
    const box = s.createThing({ name: "Box C2", kind: "container", parentId: room.id });
    expect(() => s.move(room.id, box.id)).toThrow(/inside itself/);
    expect(() => s.move(box.id, box.id)).toThrow(/inside itself/);
    expect(() => s.move(box.id, "B-0999")).toThrow(/No thing/);
    expect(() => s.createThing({ name: " " })).toThrow(/name/);
  });

  it("changes fields and undoes / redoes them", () => {
    const s = store();
    const t = s.createThing({ name: "Calipers", data: { quantity: 1 } });
    s.change(t.id, { name: "Metal calipers", data: { quantity: 2, maker: "Mitutoyo" } }, "ai");
    let v = s.mustGet(t.id);
    expect(v.name).toBe("Metal calipers");
    expect(v.data).toEqual({ quantity: 2, maker: "Mitutoyo" });
    expect(v.meta.maker?.source).toBe("ai");

    const ev = s.events({ thingId: t.id, types: ["thing.changed"] })[0]!;
    s.toggleUndo(ev.seq);
    v = s.mustGet(t.id);
    expect(v.name).toBe("Calipers");
    expect(v.data).toEqual({ quantity: 1 });
    expect(v.meta.maker).toBeUndefined();
    expect(v.meta.quantity?.source).toBe("you");
    expect(s.events({ thingId: t.id }).find((e) => e.seq === ev.seq)?.undone).toBe(true);

    s.toggleUndo(ev.seq); // redo
    v = s.mustGet(t.id);
    expect(v.name).toBe("Metal calipers");
    expect(v.meta.maker?.source).toBe("ai");
    expect(s.events({ thingId: t.id }).find((e) => e.seq === ev.seq)?.undone).toBe(false);
  });

  it("undoes moves, status and creation", () => {
    const s = store();
    const a = s.createThing({ name: "Living room", kind: "room" });
    const b = s.createThing({ name: "Bathroom", kind: "room" });
    const clip = s.createThing({ name: "Dog clippers", parentId: a.id });
    s.move(clip.id, b.id);
    s.setStatus(clip.id, "missing", "not on the sofa");
    const [status, move] = s.events({ thingId: clip.id, limit: 2 });
    s.toggleUndo(move!.seq);
    expect(s.mustGet(clip.id).parentId).toBe(a.id);
    s.toggleUndo(status!.seq);
    expect(s.mustGet(clip.id).status).toBe("ok");

    const created = s.events({ thingId: clip.id, types: ["thing.created"] })[0]!;
    s.toggleUndo(created.seq);
    expect(s.mustGet(clip.id).archivedAt).not.toBeNull();
    expect(s.search("clippers")).toHaveLength(0);
    s.toggleUndo(created.seq);
    expect(s.search("clippers")).toHaveLength(1);
  });

  it("searches by prefix, path, tags, refs and id", () => {
    const s = store();
    const room = s.createThing({ name: "Bathroom", kind: "room" });
    const cab = s.createThing({ name: "Mirror cabinet", kind: "furniture", parentId: room.id });
    const para = s.createThing({
      name: "Paracétamol 500 mg",
      parentId: cab.id,
      data: { tags: ["medicine"] },
    });
    s.link(para.id, "homebox", "uuid-1", { assetId: "000-077" });
    expect(s.search("parac")[0]?.thing.id).toBe(para.id);
    expect(s.search("paracetamol")[0]?.thing.id).toBe(para.id); // diacritics folded
    expect(s.search("medic").map((h) => h.thing.id)).toEqual([para.id]);
    expect(s.search("bathroom").map((h) => h.thing.id)).toContain(para.id); // via path
    expect(s.search("000-077")[0]?.thing.id).toBe(para.id);
    expect(s.search(para.id)[0]?.thing.id).toBe(para.id);
    // renaming a place reindexes everything inside it
    s.change(room.id, { name: "Salle de bain" });
    expect(s.search("salle").map((h) => h.thing.id)).toContain(para.id);
    expect(ftsQuery("  ")).toBeNull();
  });

  it("lists gaps for Needs details", () => {
    const s = store();
    const k = s.createThing({ name: "Kitchen", kind: "room" });
    const dw = s.createThing({ name: "LAGAN dishwasher", kind: "appliance", data: { maker: "IKEA" } });
    expect(dw.gaps).toEqual(["where", "model", "serial"]);
    s.move(dw.id, k.id);
    s.change(dw.id, { data: { model: "LAGAN", serial: "123" } });
    expect(s.needsDetails()).toHaveLength(0);
    expect(s.mustGet(k.id).gaps).toEqual([]); // places have no gaps
  });

  it("supports user-defined kinds", () => {
    const s = store();
    s.defineKind({
      id: "plant",
      name: "Plant",
      isPlace: false,
      fields: [{ key: "water", label: "Watering", type: "text", wanted: true }],
    });
    const m = s.createThing({ name: "Monstera", kind: "plant" });
    expect(m.gaps).toEqual(["where", "water"]);
    expect(() => s.createThing({ name: "x", kind: "nope" })).toThrow(/Unknown kind/);
  });

  it("rebuild() replays the log into identical projections", () => {
    const s = store();
    const room = s.createThing({ name: "Office", kind: "room" });
    const drawer = s.createThing({ name: "Alex drawer 3", kind: "furniture", parentId: room.id });
    const esp = s.createThing({ name: "ESP32 DevKit", kind: "electronics", data: { tags: ["wifi"] } });
    s.move(esp.id, drawer.id);
    s.change(esp.id, { data: { maker: "Espressif" } }, "ai");
    s.confirm(esp.id, ["maker"]);
    s.link(esp.id, "homebox", "abc", { assetId: "000-001" });
    s.addEdge("documents", esp.id, "paperless:12");
    s.defineKind({ id: "plant", name: "Plant", isPlace: false, fields: [] });
    const ev = s.events({ thingId: esp.id, types: ["thing.moved"] })[0]!;
    s.toggleUndo(ev.seq);
    s.toggleUndo(ev.seq);
    s.setStatus(esp.id, "missing");

    const before = snapshot(s);
    s.rebuild();
    expect(snapshot(s)).toEqual(before);
    expect(s.createThing({ name: "next" }).id).toBe("B-0004");
  });
});
