import { describe, expect, test } from "bun:test";
import { asId, type Place } from "../src/api.ts";
import { parseArgs } from "../src/cli.ts";
import { resolvePlace } from "../src/places.ts";
import { ago, cut, fit, foldPath, width } from "../src/text.ts";
import { parseInput } from "../src/app/screens/Thing.tsx";

describe("text", () => {
  test("cut and fit count terminal cells", () => {
    expect(cut("Pinecil V2", 20)).toBe("Pinecil V2");
    expect(cut("Pinecil V2", 6)).toBe("Pinec…");
    expect(width(fit("日本", 6))).toBe(6);
    expect(fit("42", 5, true)).toBe("   42");
  });
  test("paths fold in the middle and keep the room and the last step", () => {
    const p = ["Bathroom", "Cabinet", "Shelf 2", "Box 42"];
    expect(foldPath(p, 80)).toBe("Bathroom › Cabinet › Shelf 2 › Box 42");
    expect(foldPath(p, 31)).toBe("Bathroom › … › Shelf 2 › Box 42");
    expect(foldPath(p, 22)).toBe("Bathroom › … › Box 42");
  });
  test("ago", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    expect(ago("2026-11-17T11:59:50Z", now)).toBe("now");
    expect(ago("2026-11-17T11:58:00Z", now)).toBe("2m");
    expect(ago("2026-11-14T12:00:00Z", now)).toBe("3d");
  });
});

describe("ids, args, places", () => {
  test("IDs as people type them", () => {
    expect(asId("b42")).toBe("B-0042");
    expect(asId("B-0207")).toBe("B-0207");
    expect(asId("ivar")).toBeNull();
  });
  test("flags", () => {
    expect(parseArgs(["add", "ESP32-CAM", "--in", "Hall/Shelf", "--json"])).toEqual({
      pos: ["add", "ESP32-CAM"],
      flags: { in: "Hall/Shelf", json: true },
    });
  });
  const places: Place[] = [
    { id: "B-0001", name: "Hall", kind: "room", path: "Hall", depth: 0 },
    { id: "B-0002", name: "Shelf", kind: "furniture", path: "Hall › Shelf", depth: 1 },
    { id: "B-0003", name: "Kitchen", kind: "room", path: "Kitchen", depth: 0 },
    { id: "B-0004", name: "Shelf", kind: "furniture", path: "Kitchen › Shelf", depth: 1 },
  ];
  test("a place by ID, path or unique name", () => {
    expect(resolvePlace("b2", places)).toMatchObject({ id: "B-0002" });
    expect(resolvePlace("hall/shelf", places)).toMatchObject({ id: "B-0002" });
    expect(resolvePlace("Kitchen > Shelf", places)).toMatchObject({ id: "B-0004" });
    expect(resolvePlace("kitchen", places)).toMatchObject({ id: "B-0003" });
    expect(resolvePlace("shelf", places)).toMatchObject({ error: expect.stringContaining("could be") });
    expect(resolvePlace("attic", places)).toMatchObject({ error: 'No place called "attic"' });
  });
  test("typed values become the field's type", () => {
    expect(parseInput("25,99", { key: "price", label: "Price", type: "money" }, null)).toBe(25.99);
    expect(parseInput("a, b,", { key: "x", label: "X", type: "list" }, null)).toEqual(["a", "b"]);
    expect(parseInput("  ", undefined, "old")).toBeNull();
  });
});
