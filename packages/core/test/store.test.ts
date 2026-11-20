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

  it("records a source per field in one change", () => {
    const s = store();
    const t = s.createThing({ name: "Dmitry's table" });
    s.change(
      t.id,
      { data: { url: "https://shop.test/p", productName: "BOLLPOJKE bureau", maker: "IKEA" } },
      "page",
      "you",
    );
    let v = s.mustGet(t.id);
    expect(v.meta.productName?.source).toBe("page");
    s.change(
      t.id,
      { name: "My table", data: { url: "https://shop.test/q" }, sources: { url: "you" } },
      "page",
    );
    v = s.mustGet(t.id);
    expect(v.meta.url?.source).toBe("you");
    expect(v.meta.name?.source).toBe("page");
    expect(s.search("bollpojke").map((h) => h.thing.id)).toEqual([t.id]);
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
    const dw = s.createThing({ name: "LAGAN dishwasher", kind: "device", data: { maker: "IKEA" } });
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
    const esp = s.createThing({ name: "ESP32 DevKit", kind: "device", data: { tags: ["wifi"] } });
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

  it("removes only unused kinds; a removed seed kind stays gone (D-039)", () => {
    const s = store();
    const iron = s.createThing({ name: "Soldering iron", kind: "component" });
    expect(() => s.removeKind("component")).toThrow(/still of kind/);
    expect(() => s.removeKind("thing")).toThrow(/used by Burrow/);
    s.defineKind({ id: "led", name: "LED", parent: "component", isPlace: false, physical: true, fields: [] });
    s.change(iron.id, { kind: "device" });
    expect(() => s.removeKind("component")).toThrow(/extends/);
    s.defineKind({ id: "led", name: "LED", parent: "thing", isPlace: false, physical: true, fields: [] });
    s.removeKind("component");
    expect(s.kind("component")).toBeNull();
    // the seed doesn't bring it back, and a rebuild agrees
    const again = new Store(s.db);
    expect(again.kind("component")).toBeNull();
    const before = snapshot(s);
    s.rebuild();
    expect(snapshot(s)).toEqual(before);
    // defining it again makes it the person's own
    s.defineKind({
      id: "component",
      name: "Part",
      parent: "thing",
      isPlace: false,
      physical: true,
      fields: [],
    });
    expect(new Store(s.db).kind("component")).toMatchObject({ name: "Part", builtin: false });
  });

  it("validates relations: kinds, cardinality, symmetry", () => {
    const s = store();
    const phone = s.createThing({ name: "Pixel 9", kind: "device" });
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

  it("merges tags: things, nested tags and names move to one tag; undo restores all", () => {
    const s = store();
    const a = s.createThing({ name: "Glue gun", kind: "device" });
    const b = s.createThing({ name: "Mug", kind: "thing" });
    s.setTags(a.id, ["crafts", "workshop"], "ai");
    s.setTags(b.id, ["craft"]);
    const crafts = s.findTag("crafts")!;
    const craft = s.findTag("craft")!;
    const workshop = s.findTag("workshop")!;
    const paint = s.ensureTag("paint", "you", craft);
    s.change(craft, { data: { aliases: ["DIY"] } });
    const snap = snapshot(s);

    const events = s.mergeTags([craft, workshop, crafts], crafts);
    expect(s.mustGet(a.id).tags.map((t) => [t.name, t.source])).toEqual([["crafts", "ai"]]);
    expect(s.mustGet(b.id).tags.map((t) => [t.name, t.source])).toEqual([["crafts", "you"]]);
    expect(s.getRaw(paint)?.parentId).toBe(crafts);
    expect(s.getRaw(craft)?.archivedAt).toBeTruthy();
    expect(s.findTag("diy")).toBe(crafts);
    expect(s.findTag("workshop")).toBe(crafts);

    for (const e of events.toReversed()) s.toggleUndo(e.seq);
    expect(snapshot(s).edges).toEqual(snap.edges);
    expect(s.getRaw(craft)?.archivedAt).toBeNull();
    expect(s.getRaw(paint)?.parentId).toBe(craft);
  });

  it("merging a tag into its own nested tag lifts that one out first", () => {
    const s = store();
    const tools = s.ensureTag("tools");
    const hand = s.ensureTag("hand tools", "you", tools);
    s.mergeTags([tools], hand);
    expect(s.getRaw(hand)?.parentId).toBeNull();
    expect(s.getRaw(tools)?.archivedAt).toBeTruthy();
    expect(() => s.mergeTags([hand], s.createThing({ name: "Box", kind: "thing" }).id)).toThrow(/not a tag/);
  });

  it("tags are things: nesting, aliases, search through parents, undo", () => {
    const s = store();
    const esp = s.createThing({ name: "ESP32 DevKit", kind: "device" });
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
    const t = s.createThing({ name: "Calipers", kind: "thing", parentId: room.id });
    s.setTags(t.id, ["measuring"]);
    s.createThing({ name: "Invoice", kind: "document" });
    expect(s.list({ physical: true }).map((x) => x.name)).toEqual(["Calipers"]);
  });
});

describe("assets", () => {
  const img = { mime: "image/jpeg", bytes: 1000, width: 800, height: 600 };

  it("adds, picks a cover automatically, and lets you choose one", () => {
    const s = store();
    const t = s.createThing({ name: "Soldering iron", kind: "device" });
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
    const t = s.createThing({ name: "Kettle", kind: "device" });
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
      kind: "device",
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
    s.createThing({ name: "Loose screwdriver", kind: "thing" });
    expect(s.placeTree().unplaced).toBe(1);
  });
});

describe("no fixed place (D-026)", () => {
  it("is not a gap, survives undo and rebuild, and clears when placed", () => {
    const s = store();
    const room = s.createThing({ name: "Office", kind: "room" });
    const laptop = s.createThing({ name: "MacBook Air", kind: "device", parentId: room.id });
    s.move(laptop.id, null, "you", undefined, undefined, true);
    let t = s.mustGet(laptop.id);
    expect([t.parentId, t.roams, t.gaps.includes("where")]).toEqual([null, true, false]);
    expect(s.placeTree()).toMatchObject({ unplaced: 0, roaming: 1 });
    expect(s.list({ roams: true }).map((x) => x.id)).toEqual([laptop.id]);

    // Undo puts it back in the room; redo makes it roam again.
    const ev = s.events({ thingId: laptop.id, types: ["thing.moved"], limit: 1 })[0]!;
    s.toggleUndo(ev.seq);
    expect(s.mustGet(laptop.id)).toMatchObject({ parentId: room.id, roams: false });
    const undo = s.events({ thingId: laptop.id, types: ["thing.moved"], limit: 1 })[0]!;
    s.toggleUndo(undo.seq);
    expect(s.mustGet(laptop.id)).toMatchObject({ parentId: null, roams: true });

    // "Not placed yet" is a different nowhere: a gap again.
    s.move(laptop.id, null);
    t = s.mustGet(laptop.id);
    expect([t.roams, t.gaps.includes("where")]).toEqual([false, true]);
    s.move(laptop.id, null, "you", undefined, undefined, true);
    s.move(laptop.id, room.id);
    expect(s.mustGet(laptop.id).roams).toBe(false);
    const back = s.events({ thingId: laptop.id, types: ["thing.moved"], limit: 1 })[0]!;
    s.toggleUndo(back.seq);
    expect(s.mustGet(laptop.id).roams).toBe(true);

    const snap = snapshot(s);
    s.rebuild();
    expect(snapshot(s)).toEqual(snap);
  });
});

describe("thingsOfTheDay (D-028)", () => {
  it("picks one per reason, stable within a day", () => {
    const s = store();
    const room = s.createThing({ name: "Cellar", kind: "room" });
    for (let i = 0; i < 6; i++) s.createThing({ name: `Box ${i}`, kind: "thing", parentId: room.id });
    s.createThing({ name: "Fridge", kind: "device", parentId: room.id });
    s.createThing({ name: "Tag", kind: "tag" });
    const a = s.thingsOfTheDay("2027-01-01");
    expect(a.map((p) => p.why).toSorted()).toEqual(["check", "field", "photo"]);
    expect(new Set(a.map((p) => p.thing.id)).size).toBe(3);
    expect(a.every((p) => p.thing.kind !== "tag" && p.thing.kind !== "room")).toBe(true);
    expect(a.find((p) => p.why === "field")!.thing.name).toBe("Fridge");
    expect(s.thingsOfTheDay("2027-01-01")).toEqual(a);
    // Seen recently: no "still there?" question.
    expect(s.thingsOfTheDay("2026-11-20").some((p) => p.why === "check")).toBe(false);
  });
});

describe("aiUnchecked", () => {
  it("lists guessed fields until a person confirms them", () => {
    const s = store();
    const t = s.createThing({
      name: "Desk",
      data: { description: "A green desk", maker: "IKEA" },
      sources: { description: "ai", maker: "you" },
    });
    expect(s.aiUnchecked().map((x) => [x.thing.id, x.fields])).toEqual([[t.id, ["description"]]]);
    s.confirm(t.id, ["description"]);
    expect(s.aiUnchecked()).toEqual([]);
  });
});

describe("asset originals, keys and file replacement", () => {
  it("replaces a processed file in place, keeps the original, undoes", () => {
    const s = store();
    const t = s.createThing({ name: "Pi Zero", kind: "device" });
    const a = s.addAsset(t.id, {
      role: "photo",
      file: "proc1.jpg",
      original: "raw1.jpg",
      key: "pcbphoto:abc",
      mime: "image/jpeg",
      bytes: 100,
      width: 1300,
      height: 600,
      data: { view: "top", pxPerMm: 20 },
    });
    expect(s.mustGet(t.id).cover?.originalUrl).toBe("/media/raw1.jpg");
    expect(s.assetByKey(t.id, "pcbphoto:abc")?.id).toBe(a.id);
    expect(() =>
      s.addAsset(t.id, { role: "photo", file: "x.jpg", key: "pcbphoto:abc", mime: "image/jpeg", bytes: 1 }),
    ).toThrow(/already has an asset with key/);

    s.changeAsset(a.id, {
      file: "proc2.jpg",
      bytes: 120,
      width: 1310,
      data: { view: "top", pxPerMm: 20, v: 2 },
    });
    expect(s.mustGetAsset(a.id)).toMatchObject({
      file: "proc2.jpg",
      bytes: 120,
      width: 1310,
      original: "raw1.jpg",
    });
    expect(() => s.changeAsset(a.id, { file: "../x" })).toThrow(/file name/);
    const snap = snapshot(s);
    s.rebuild();
    expect(snapshot(s)).toEqual(snap);
    expect(s.mustGetAsset(a.id).data).toEqual({ view: "top", pxPerMm: 20, v: 2 });

    const ev = s.events({ thingId: t.id, types: ["asset.changed"], limit: 1 })[0]!;
    s.toggleUndo(ev.seq);
    expect(s.mustGetAsset(a.id)).toMatchObject({
      file: "proc1.jpg",
      bytes: 100,
      width: 1300,
      data: { view: "top", pxPerMm: 20 },
    });
  });
});

function chairsInStorage() {
  const s = store();
  const storage = s.createThing({ name: "Storage", kind: "room" });
  const bedroom = s.createThing({ name: "Bedroom", kind: "room" });
  const chairs = s.createThing({
    name: "Chair",
    data: { quantity: 3, maker: "IKEA" },
    parentId: storage.id,
    sources: { maker: "ai" },
  });
  s.setTags(chairs.id, ["furniture"]);
  const cushion = s.createThing({ name: "Cushion" });
  s.relate("accessory_of", cushion.id, chairs.id);
  s.addAsset(chairs.id, { role: "photo", file: "chair.jpg", mime: "image/jpeg", bytes: 10 });
  s.move(chairs.id, storage.id, "you", undefined, "shelf 2");
  return { s, storage, bedroom, chairs, cushion };
}

describe("stock: split and combine (D-036)", () => {
  it("splits some off into another place, copying what describes it", () => {
    const { s, bedroom, chairs, cushion } = chairsInStorage();
    const { thing: one } = s.split(chairs.id, 1, { to: bedroom.id });
    expect(s.mustGet(chairs.id).data.quantity).toBe(2);
    expect(one).toMatchObject({ name: "Chair", parentId: bedroom.id, position: null });
    expect(one.data).toEqual({ maker: "IKEA" });
    expect(one.meta.maker?.source).toBe("ai");
    expect(one.tags.map((t) => t.name)).toEqual(["furniture"]);
    expect(one.cover).not.toBeNull();
    expect(s.assets(one.id).map((a) => a.file)).toEqual(["chair.jpg"]);
    // The cushion belongs to one of them, not both.
    expect(s.relations(one.id).map((r) => [r.type, r.other.id])).toEqual([
      ["tagged", one.tags[0]!.id],
      ["split_from", chairs.id],
    ]);
    expect(s.edges({ type: "accessory_of", fromId: cushion.id }).map((e) => e.toId)).toEqual([chairs.id]);
    expect(s.stockFamily(chairs.id).map((t) => t.id)).toEqual([one.id]);

    // Staying put keeps the spot.
    const two = s.split(chairs.id, 1).thing;
    expect([two.parentId, two.position]).toEqual([chairs.parentId, "shelf 2"]);
    expect(s.mustGet(chairs.id).data.quantity).toBeUndefined();

    const snap = snapshot(s);
    s.rebuild();
    expect(snapshot(s)).toEqual(snap);
  });

  it("undoes a split completely (its events, newest first)", () => {
    const { s, bedroom, chairs } = chairsInStorage();
    const { thing, events } = s.split(chairs.id, 2, { to: bedroom.id, position: "by the bed" });
    expect(thing).toMatchObject({ position: "by the bed", data: { quantity: 2 } });
    for (const e of events.toReversed()) s.toggleUndo(e.seq);
    expect(s.mustGet(thing.id).archivedAt).not.toBeNull();
    expect(s.mustGet(chairs.id).data.quantity).toBe(3);
    expect(s.stockFamily(chairs.id)).toEqual([]);
  });

  it("refuses what can't be split", () => {
    const { s, storage, chairs, cushion } = chairsInStorage();
    expect(() => s.split(chairs.id, 3)).toThrow(/between 1 and 2/);
    expect(() => s.split(chairs.id, 0)).toThrow(/between 1 and 2/);
    expect(() => s.split(cushion.id, 1)).toThrow(/just one/);
    expect(() => s.split(storage.id, 1)).toThrow(/count of/);
  });

  it("combines back: count, links, pictures and things inside move over", () => {
    const { s, storage, bedroom, chairs, cushion } = chairsInStorage();
    const one = s.split(chairs.id, 1, { to: bedroom.id }).thing;
    s.addAsset(one.id, { role: "photo", file: "bedroom-chair.jpg", mime: "image/jpeg", bytes: 10 });
    s.change(one.id, { data: { notes: "wobbly leg" } });
    const pillow = s.createThing({ name: "Pillow" });
    s.relate("accessory_of", pillow.id, one.id);
    const coin = s.createThing({ name: "Lost coin", parentId: one.id });

    const events = s.combine([one.id], chairs.id);
    const kept = s.mustGet(chairs.id);
    expect(kept).toMatchObject({ parentId: storage.id, data: { quantity: 3, notes: "wobbly leg" } });
    expect(s.assets(kept.id).map((a) => a.file)).toEqual(["chair.jpg", "bedroom-chair.jpg"]);
    expect(
      s
        .edges({ type: "accessory_of", toId: kept.id })
        .map((e) => e.fromId)
        .toSorted(),
    ).toEqual([cushion.id, pillow.id].toSorted());
    expect(s.mustGet(coin.id).parentId).toBe(kept.id);
    const gone = s.mustGet(one.id);
    expect(gone.archivedAt).not.toBeNull();
    expect(s.edges({ type: "merged_into", fromId: one.id }).map((e) => e.toId)).toEqual([kept.id]);
    expect(s.stockFamily(kept.id)).toEqual([]);

    const snap = snapshot(s);
    s.rebuild();
    expect(snapshot(s)).toEqual(snap);

    for (const e of events.toReversed()) s.toggleUndo(e.seq);
    expect(s.mustGet(one.id)).toMatchObject({ archivedAt: null, parentId: bedroom.id });
    expect(s.mustGet(chairs.id).data.quantity).toBe(2);
    expect(s.mustGet(chairs.id).data.notes).toBeUndefined();
    expect(s.mustGet(coin.id).parentId).toBe(one.id);
    expect(s.edges({ type: "accessory_of", fromId: pillow.id }).map((e) => e.toId)).toEqual([one.id]);
  });

  it("moves some back without archiving, and finds family through combined ones", () => {
    const { s, bedroom, chairs } = chairsInStorage();
    const two = s.split(chairs.id, 2, { to: bedroom.id }).thing;
    s.combine([two.id], chairs.id, { count: 1 });
    expect([s.mustGet(chairs.id).data.quantity, s.mustGet(two.id).data.quantity]).toEqual([2, undefined]);
    expect(() => s.combine([two.id], chairs.id, { count: 2 })).toThrow(/between 1 and 1/);

    // A split off the original, then the original combined into it: the bedroom one is still family.
    const third = s.split(chairs.id, 1).thing;
    s.combine([chairs.id], third.id);
    expect(s.stockFamily(third.id).map((t) => t.id)).toEqual([two.id]);
    expect(s.mustGet(third.id).data.quantity).toBe(2);

    const lamp = s.createThing({ name: "Lamp", kind: "device" });
    expect(() => s.combine([lamp.id], third.id)).toThrow(/not the same stock/);
  });
});

describe("duplicate (D-038)", () => {
  function boxOnShelf() {
    const s = store();
    const shelf = s.createThing({ name: "Shelf", kind: "room" });
    const box = s.createThing({
      name: "Gridfinity box",
      kind: "container",
      data: { material: "PETG" },
      parentId: shelf.id,
      sources: { material: "ai" },
    });
    s.setTags(box.id, ["3d printed"]);
    s.addAsset(box.id, { role: "photo", file: "box.jpg", mime: "image/jpeg", bytes: 10 });
    s.move(box.id, shelf.id, "you", undefined, "left");
    const screws = s.createThing({ name: "M3 screws", parentId: box.id });
    const lid = s.createThing({ name: "Lid" });
    s.relate("accessory_of", lid.id, box.id);
    return { s, shelf, box, screws, lid };
  }

  it("makes an empty copy next to it with the next number", () => {
    const { s, shelf, box, screws, lid } = boxOnShelf();
    const { thing: two, events } = s.duplicate(box.id);
    expect(two).toMatchObject({
      name: "Gridfinity box 2",
      kind: "container",
      parentId: shelf.id,
      position: null,
    });
    expect(two.data).toEqual({ material: "PETG" });
    expect(two.meta.material?.source).toBe("ai");
    expect(two.tags.map((t) => t.name)).toEqual(["3d printed"]);
    expect(s.assets(two.id).map((a) => a.file)).toEqual(["box.jpg"]);
    expect(two.cover).not.toBeNull();
    expect(s.edges({ type: "copied_from", fromId: two.id }).map((e) => e.toId)).toEqual([box.id]);
    // Contents and accessories stay with the original.
    expect(s.mustGet(screws.id).parentId).toBe(box.id);
    expect(s.edges({ type: "accessory_of", fromId: lid.id }).map((e) => e.toId)).toEqual([box.id]);
    expect(s.stockFamily(box.id)).toEqual([]);

    expect(s.duplicate(two.id).thing.name).toBe("Gridfinity box 3");
    expect(s.duplicate(box.id, { name: "Bits box" }).thing.name).toBe("Bits box");

    const snap = snapshot(s);
    s.rebuild();
    expect(snapshot(s)).toEqual(snap);

    for (const e of events.toReversed()) s.toggleUndo(e.seq);
    expect(s.mustGet(two.id).archivedAt).not.toBeNull();
  });

  it("is one copy of stock, and refuses tags and archived things", () => {
    const { s, box } = boxOnShelf();
    const chairs = s.createThing({ name: "Chair 7", data: { quantity: 3 } });
    expect(s.duplicate(chairs.id).thing).toMatchObject({ name: "Chair 8", data: {} });
    const tag = s.ensureTag("3d printed");
    expect(() => s.duplicate(tag)).toThrow(/another of/);
    s.archive(box.id);
    expect(() => s.duplicate(box.id)).toThrow(/archived/);
  });
});
