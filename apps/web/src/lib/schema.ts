import { useQuery } from "@tanstack/react-query";
import { get, type Kind, type Schema } from "./api.ts";

/** Kinds + relation types, cached; invalidated with everything else after writes. */
export function useSchema() {
  return useQuery({ queryKey: ["schema"], queryFn: () => get<Schema>("/schema"), staleTime: 60_000 });
}

/** Is `kind` the kind `ancestor` or one extending it? */
export function kindIs(kinds: Kind[], kind: string, ancestor: string): boolean {
  const seen = new Set<string>();
  for (let k: string | null = kind; k && !seen.has(k); k = kinds.find((x) => x.id === k)?.parent ?? null) {
    if (k === ancestor) return true;
    seen.add(k);
  }
  return false;
}

/** Kinds you'd pick when adding a thing (tags and documents have their own flows). */
export function useThingKinds() {
  const { data } = useSchema();
  return (data?.kinds ?? []).filter((k) => !k.isTag && !k.isDocument);
}
