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
      parent: null,
      isPlace: false,
      physical: true,
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
    s.setTags(esp.id, ["wifi", "esp32"], "ai");
    const doc = s.createThing({ name: "ESP32 invoice", kind: "document" });
    s.relate("has_document", esp.id, doc.id);
    s.defineKind({ id: "plant", name: "Plant", parent: "thing", isPlace: false, physical: true, fields: [] });
    s.defineRelation({
      id: "waters",
      name: "waters",
      inverse: "watered by",
      fromKinds: [],
      toKinds: ["plant"],
      cardinality: "many",
      symmetric: false,
    });
    const ev = s.events({ thingId: esp.id, types: ["thing.moved"] })[0]!;
    s.toggleUndo(ev.seq);
    s.toggleUndo(ev.seq);
    s.setStatus(esp.id, "missing");

    const before = snapshot(s);
    s.rebuild();
    expect(snapshot(s)).toEqual(before);
    expect(s.createThing({ name: "next" }).id).toBe("B-0007"); // 3 things + 2 tags + 1 document before
  });
});

describe("schema as data", () => {
  it("inherits fields and traits through parent kinds", () => {
    const s = store();
    s.defineKind({
      id: "plant",
      name: "Plant",
      parent: "thing",
      isPlace: false,
      physical: true,
      fields: [
        { key: "water", label: "Watering", type: "select", options: ["weekly", "monthly"], wanted: true },
        { key: "maker", label: "Nursery", type: "text" },
      ],
    });
    const keys = s.fieldsOf("plant").map((f) => f.key);
    expect(keys).toContain("description"); // from thing
    expect(keys).toContain("water");
    expect(s.fieldsOf("plant").find((f) => f.key === "maker")?.label).toBe("Nursery"); // child overrides
    expect(s.kindIs("plant", "thing")).toBe(true);
    expect(() =>
      s.defineKind({
        id: "thing",
        name: "Thing",
        parent: "plant",
        isPlace: false,
        physical: true,
        fields: [],
      }),
    ).toThrow(/extend themselves/);
    // non-physical kinds have no "where" gap
    expect(s.createThing({ name: "Taxes 2025", kind: "document" }).gaps).toEqual([]);
  });

  it("validates relations: kinds, cardinality, symmetry", () => {
    const s = store();
    const phone = s.createThing({ name: "Pixel 9", kind: "electronics" });
    const caseT = s.createThing({ name: "Pixel 9 case" });
    const old = s.createThing({ name: "Pixel 7" });
    const older = s.createThing({ name: "Pixel 5" });
    s.relate("accessory_of", caseT.id, phone.id);
    expect(s.relations(phone.id)).toMatchObject([
      { type: "accessory_of", direction: "in", label: "accessories", other: { id: caseT.id } },
    ]);
    expect(() => s.relate("tagged", phone.id, caseT.id)).toThrow(/can't link/); // tagged → tag only
    expect(() => s.relate("nope", phone.id, caseT.id)).toThrow(/Unknown relation/);
    expect(() => s.relate("related", phone.id, phone.id)).toThrow(/itself/);

    // "one": relating again replaces the old link
    s.relate("replaces", phone.id, old.id);
    s.relate("replaces", phone.id, older.id);
    expect(s.edges({ type: "replaces", fromId: phone.id }).map((e) => e.toId)).toEqual([older.id]);

    // symmetric: stored once, visible from both sides, removable from either
    s.relate("related", old.id, older.id);
    s.relate("related", older.id, old.id);
    expect(s.edges({ type: "related" })).toHaveLength(1);
    expect(s.relations(older.id).find((r) => r.type === "related")?.label).toBe("related to");
    s.unrelate("related", older.id, old.id);
    expect(s.edges({ type: "related" })).toHaveLength(0);
  });

  it("tags are things: nesting, aliases, search through parents, undo", () => {
    const s = store();
    const esp = s.createThing({ name: "ESP32 DevKit", kind: "electronics" });
    s.setTags(esp.id, ["sensors", "WiFi"], "ai");
    const wifi = s.findTag("wifi")!;
    expect(s.mustGet(esp.id).tags.map((t) => t.name)).toEqual(["sensors", "WiFi"]);
    expect(s.mustGet(esp.id).tags[0]?.source).toBe("ai");

    // nest "sensors" under "electronics" → searching the parent finds the thing
    const elec = s.ensureTag("electronics");
    s.move(s.findTag("sensors")!, elec);
    expect(s.mustGet(esp.id).tags.find((t) => t.name === "sensors")?.path).toEqual(["electronics"]);
    expect(s.search("electronics").map((h) => h.thing.id)).toContain(esp.id);
    expect(s.taggedWith(elec).map((t) => t.id)).toEqual([esp.id]);

    // rename a tag → things re-indexed
    s.change(wifi, { name: "wireless" });
    expect(s.search("wireless").map((h) => h.thing.id)).toContain(esp.id);

    // aliases resolve to the same tag
    s.change(wifi, { data: { aliases: ["wi-fi"] } });
    expect(s.findTag("Wi-Fi")).toBe(wifi);

    // removing a tag is undoable, with its provenance
    s.setTags(esp.id, ["sensors"]);
    const removed = s.events({ types: ["edge.removed"], limit: 1 })[0]!;
    s.toggleUndo(removed.seq);
    expect(s.mustGet(esp.id).tags.find((t) => t.id === wifi)?.source).toBe("ai");
    // tags are not physical: no "Needs details" for them
    expect(s.needsDetails().map((t) => t.id)).not.toContain(wifi);
  });
});

describe("field types", () => {
  it("checks declared fields, leaves extra fields free-form", () => {
    const s = store();
    const room = s.createThing({ name: "Kitchen", kind: "room" });
    s.defineKind({
      id: "plant",
      name: "Plant",
      parent: "thing",
      isPlace: false,
      physical: true,
      fields: [
        { key: "water", label: "Watering", type: "select", options: ["weekly", "monthly"] },
        { key: "toxic", label: "Toxic to pets", type: "boolean" },
        { key: "spot", label: "Best spot", type: "ref", refKind: "room" },
      ],
    });
    const p = s.createThing({
      name: "Monstera",
      kind: "plant",
      data: { water: "weekly", toxic: true, spot: room.id },
    });
    expect(() => s.change(p.id, { data: { water: "daily" } })).toThrow(/one of weekly, monthly/);
    expect(() => s.change(p.id, { data: { toxic: "yes" } })).toThrow(/yes or no/);
    expect(() => s.change(p.id, { data: { quantity: "two" } })).toThrow(/number/); // inherited from thing
    expect(() => s.change(p.id, { data: { spot: p.id } })).toThrow(/must point to a room/);
    expect(() => s.change(p.id, { data: { purchaseDate: "last week" } })).toThrow(/date/);
    s.change(p.id, { data: { potSize: "24 cm", water: null } }); // free-form extra field; clearing is always fine
    expect(s.mustGet(p.id).data).toMatchObject({ potSize: "24 cm", toxic: true });
  });
});

describe("list filters", () => {
  it("physical: only real things, no tags, documents or places", () => {
    const s = store();
    const room = s.createThing({ name: "Office", kind: "room" });
    const t = s.createThing({ name: "Calipers", kind: "tool", parentId: room.id });
    s.setTags(t.id, ["measuring"]);
    s.createThing({ name: "Invoice", kind: "document" });
    expect(s.list({ physical: true }).map((x) => x.name)).toEqual(["Calipers"]);
  });
});

describe("assets", () => {
  const img = { mime: "image/jpeg", bytes: 1000, width: 800, height: 600 };

  it("adds, picks a cover automatically, and lets you choose one", () => {
    const s = store();
    const t = s.createThing({ name: "Soldering iron", kind: "tool" });
    expect(s.mustGet(t.id).cover).toBeNull();
    const icon = s.addAsset(t.id, { role: "icon", file: "aaa.svg", mime: "image/svg+xml", bytes: 300 });
    expect(icon.id).toBe("A-0001");
    expect(s.mustGet(t.id).cover?.id).toBe(icon.id);
    const photo = s.addAsset(t.id, { role: "photo", file: "bbb.jpg", thumb: "bbb-t.webp", ...img });
    // A real photo beats an icon when nobody chose.
    expect(s.mustGet(t.id).cover).toMatchObject({
      id: photo.id,
      imageUrl: "/media/bbb.jpg",
      thumbUrl: "/media/bbb-t.webp",
    });
    s.setCover(t.id, icon.id);
    expect(s.mustGet(t.id).cover?.id).toBe(icon.id);
    s.removeAsset(icon.id);
    expect(s.mustGet(t.id).cover?.id).toBe(photo.id); // falls back
    expect(s.assets(t.id).map((a) => a.id)).toEqual([photo.id]);
    expect(s.assets(t.id, { removed: true })).toHaveLength(2);
  });

  it("a 3D model is only a cover once it has a poster", () => {
    const s = store();
    const t = s.createThing({ name: "Raspberry Pi case" });
    const m = s.addAsset(t.id, { role: "model", file: "m.glb", mime: "model/gltf-binary", bytes: 5 });
    expect(s.mustGet(t.id).cover).toBeNull();
    s.changeAsset(m.id, { thumb: "m-poster.webp" });
    expect(s.mustGet(t.id).cover).toMatchObject({
      fileUrl: "/media/m.glb",
      imageUrl: "/media/m-poster.webp",
    });
  });

  it("validates", () => {
    const s = store();
    const a = s.createThing({ name: "A" });
    const b = s.createThing({ name: "B" });
    const x = s.addAsset(a.id, { role: "photo", file: "x.jpg", ...img });
    expect(() => s.setCover(b.id, x.id)).toThrow(/belongs to/);
    expect(() => s.addAsset(a.id, { role: "hologram" as "photo", file: "y.jpg", ...img })).toThrow(/role/);
    expect(() => s.addAsset(a.id, { role: "photo", file: "../etc/passwd", ...img })).toThrow(/file name/);
    expect(() => s.changeAsset(x.id, { role: "nope" as "photo" })).toThrow(/role/);
    s.removeAsset(x.id);
    expect(() => s.setCover(a.id, x.id)).toThrow(/removed/);
  });

  it("every asset change undoes, redoes and survives a rebuild", () => {
    const s = store();
    const t = s.createThing({ name: "Kettle", kind: "appliance" });
    const p = s.addAsset(t.id, {
      role: "product",
      file: "p.jpg",
      ...img,
      source: "page",
      data: { url: "https://x" },
    });
    const q = s.addAsset(t.id, { role: "photo", file: "q.jpg", ...img });
    s.changeAsset(p.id, { role: "photo", label: "box art" });
    s.setCover(t.id, p.id);
    const snap = (x: Store) => ({
      ...snapshot(x),
      assets: x.db.prepare("select * from assets order by id").all(),
    });
    const before = snap(s);
    s.rebuild();
    expect(snap(s)).toEqual(before);

    const ev = s.events({ thingId: t.id, types: ["asset.cover", "asset.changed", "asset.added"] });
    const [cover, changed] = ev;
    s.toggleUndo(cover!.seq);
    expect(s.coverId(t.id)).toBeNull(); // automatic again (both are photos now, the older wins)
    expect(s.mustGet(t.id).cover?.id).toBe(p.id);
    s.toggleUndo(changed!.seq);
    expect(s.mustGetAsset(p.id)).toMatchObject({ role: "product" });
    expect(s.mustGetAsset(p.id).label).toBeUndefined();
    s.toggleUndo(changed!.seq); // redo
    expect(s.mustGetAsset(p.id)).toMatchObject({ role: "photo", label: "box art" });
    const added = ev.find((e) => e.body.type === "asset.added" && e.body.asset.id === q.id)!;
    s.toggleUndo(added.seq);
    expect(s.assets(t.id).map((a) => a.id)).toEqual([p.id]);
    s.toggleUndo(added.seq);
    expect(s.assets(t.id).map((a) => a.id)).toEqual([p.id, q.id]);
    const live = snap(s);
    s.rebuild();
    expect(snap(s)).toEqual(live);
  });
});

describe("places: positions and tree", () => {
  it("keeps a spot inside the parent, with undo, search and rebuild", () => {
    const s = store();
    const room = s.createThing({ name: "Living room", kind: "room" });
    const ivar = s.createThing({ name: "IVAR", kind: "furniture", parentId: room.id });
    const crate = s.createThing({ name: "Crate", kind: "container", parentId: ivar.id });
    const box = s.createThing({ name: "Modubox", kind: "container", parentId: crate.id });
    const leds = s.createThing({
      name: "LEDs 5 mm",
      kind: "electronics",
      parentId: box.id,
      data: { quantity: 10 },
    });

    s.move(crate.id, ivar.id, "you", undefined, " shelf 3 ");
    expect(s.mustGet(crate.id).position).toBe("shelf 3");
    expect(s.mustGet(leds.id).path.map((p) => [p.name, p.position ?? null])).toEqual([
      ["Living room", null],
      ["IVAR", null],
      ["Crate", "shelf 3"],
      ["Modubox", null],
    ]);
    expect(s.search("shelf 3").map((h) => h.thing.id)).toContain(leds.id);

    // Same parent, no position given: the spot stays. Another parent: it's cleared.
    s.move(crate.id, ivar.id);
    expect(s.mustGet(crate.id).position).toBe("shelf 3");
    s.move(crate.id, ivar.id, "you", undefined, "shelf 4");
    const ev = s.events({ thingId: crate.id, types: ["thing.moved"], limit: 1 })[0]!;
    s.toggleUndo(ev.seq);
    expect(s.mustGet(crate.id).position).toBe("shelf 3");
    s.move(crate.id, room.id);
    expect(s.mustGet(crate.id).position).toBeNull();
    s.move(crate.id, ivar.id, "you", undefined, "shelf 3");
    s.move(box.id, crate.id, "you", undefined, "front left");
    expect(s.positionsIn(ivar.id)).toEqual(["shelf 3"]);
    expect(() => s.move(box.id, crate.id, "you", undefined, "x".repeat(81))).toThrow(/short/);

    const snap = snapshot(s);
    s.rebuild();
    expect(snapshot(s)).toEqual(snap);

    const tree = s.placeTree();
    const n = (id: string) => tree.places.find((p) => p.id === id)!;
    expect(n(room.id)).toMatchObject({ items: 0, total: 1 });
    expect(n(box.id)).toMatchObject({ items: 1, total: 1, position: "front left" });
    expect(n(crate.id)).toMatchObject({ items: 0, total: 1, parentId: ivar.id, position: "shelf 3" });
    s.createThing({ name: "Loose screwdriver", kind: "tool" });
    expect(s.placeTree().unplaced).toBe(1);
  });
});
