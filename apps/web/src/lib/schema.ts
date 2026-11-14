import { useQuery } from "@tanstack/react-query";
import { get, type Schema } from "./api.ts";

/** Kinds + relation types, cached; invalidated with everything else after writes. */
export function useSchema() {
  return useQuery({ queryKey: ["schema"], queryFn: () => get<Schema>("/schema"), staleTime: 60_000 });
}

/** Kinds you'd pick when adding a thing (tags and documents have their own flows). */
export function useThingKinds() {
  const { data } = useSchema();
  return (data?.kinds ?? []).filter((k) => !k.isTag && !k.isDocument);
}
