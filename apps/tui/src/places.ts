import { asId, type Place } from "./api.ts";

const norm = (s: string) =>
  s
    .toLowerCase()
    .split(/\s*(?:›|\/|>)\s*/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" › ");

/**
 * Find one place from what someone typed: an ID ("b31"), a full path ("Working Room › Desk",
 * also with "/" or ">" between steps) or a name that only one place has.
 */
export function resolvePlace(input: string, places: Place[]): Place | { error: string } {
  const id = asId(input);
  if (id) {
    const p = places.find((x) => x.id === id);
    return p ?? { error: `${id} isn't a place` };
  }
  const want = norm(input);
  const exact = places.filter((p) => norm(p.path) === want);
  if (exact.length === 1) return exact[0]!;
  const tail = places.filter((p) => norm(p.path).endsWith(want) && norm(p.name) === want.split(" › ").at(-1));
  if (tail.length === 1) return tail[0]!;
  const some = tail.length ? tail : places.filter((p) => norm(p.path).includes(want));
  if (some.length === 1) return some[0]!;
  if (!some.length) return { error: `No place called "${input}"` };
  return {
    error: `"${input}" could be ${some
      .slice(0, 5)
      .map((p) => `${p.path} (${p.id})`)
      .join(", ")}${some.length > 5 ? "…" : ""}`,
  };
}
