import { describe, expect, it } from "vitest";
import { Store } from "@burrow/core";
import { findDuplicates } from "../src/duplicates.ts";
import type { LookPairs, VisualMatcher } from "../src/vision.ts";

/** Picture scores given by hand. */
function looks(scores: Record<string, number>, pictured: string[] = []): VisualMatcher {
  const p: LookPairs = {
    scores: new Map(Object.entries(scores)),
    pictured: new Set([...pictured, ...Object.keys(scores).flatMap((k) => k.split("|"))]),
  };
  return { similar: async () => [], refresh: async () => 0, pairs: () => p };
}

const names = (xs: ReturnType<typeof findDuplicates>) => xs.map((p) => [p.a.name, p.b.name, p.why]);

describe("duplicates", () => {
  it("finds same names, look-alikes with similar names, and forgets dismissed pairs", () => {
    const s = Store.open(":memory:");
    const a = s.createThing({ name: "ProMicro nRF52840" }).id; // B-0001
    const b = s.createThing({ name: "promicro  NRF52840" }).id; // B-0002
    const c = s.createThing({ name: "HX711 Load Cell Amplifier" }).id; // B-0003
    const d = s.createThing({ name: "CJMCU-711 HX711 load cell amp" }).id; // B-0004
    const e = s.createThing({ name: "Seeed XIAO ESP32S3" }).id; // B-0005
    const f = s.createThing({ name: "Seeed XIAO RP2040" }).id; // B-0006
    s.createThing({ name: "promicro nrf52840", kind: "tag" }); // tags aren't things you own twice
    const v = looks({ [`${c}|${d}`]: 0.93, [`${e}|${f}`]: 0.92 });

    expect(names(findDuplicates(s, v))).toEqual([
      ["ProMicro nRF52840", "promicro  NRF52840", "name"],
      ["HX711 Load Cell Amplifier", "CJMCU-711 HX711 load cell amp", "both"],
    ]);

    // Same name but both pictured and nothing alike: not offered. Very close looks are, whatever the names.
    expect(names(findDuplicates(s, looks({ [`${e}|${f}`]: 0.97 }, [a, b])))).toEqual([
      ["Seeed XIAO ESP32S3", "Seeed XIAO RP2040", "looks"],
    ]);

    s.relate("not_same", b, a);
    expect(names(findDuplicates(s, v))).toEqual([
      ["HX711 Load Cell Amplifier", "CJMCU-711 HX711 load cell amp", "both"],
    ]);
    // Any other link says you know they're two things too.
    s.relate("accessory_of", c, d);
    expect(findDuplicates(s, v)).toEqual([]);
  });

  it("pairs places only within the same place", () => {
    const s = Store.open(":memory:");
    const one = s.createThing({ name: "Cabinet", kind: "room" }).id;
    const two = s.createThing({ name: "Shelf", kind: "room" }).id;
    s.createThing({ name: "Drawer 1", kind: "container", parentId: one });
    s.createThing({ name: "Drawer 1", kind: "container", parentId: two });
    expect(findDuplicates(s, looks({}))).toEqual([]);
    s.createThing({ name: "drawer 1", kind: "container", parentId: one });
    expect(findDuplicates(s, looks({}))).toHaveLength(1);
  });
});
