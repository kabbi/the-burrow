import { useQuery } from "@tanstack/react-query";
import {
  get,
  type EventRow,
  type Hits,
  type Overview,
  type Place,
  type PlaceNode,
  type Schema,
  type TagInfo,
  type ThingDetail,
  type ThingView,
  type TidyData,
} from "../api.ts";

// Queries, as in the web app: small data set, invalidate everything after a write.

export const useOverview = () =>
  useQuery({ queryKey: ["overview"], queryFn: () => get<Overview>("/overview") });

export const useSearch = (q: string) =>
  useQuery({
    queryKey: ["search", q],
    queryFn: () => get<Hits>(`/search?q=${encodeURIComponent(q)}&limit=60`),
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });

export const useThing = (id: string | null) =>
  useQuery({
    queryKey: ["thing", id],
    queryFn: () => get<ThingDetail>(`/things/${id}`),
    enabled: Boolean(id),
  });

export const usePlaces = () =>
  useQuery({ queryKey: ["places"], queryFn: async () => (await get<{ places: Place[] }>("/places")).places });

export const usePlaceTree = () =>
  useQuery({
    queryKey: ["places", "tree"],
    queryFn: () => get<{ places: PlaceNode[]; unplaced: number; roaming: number }>("/places/tree"),
  });

export const useChildren = (id: string | null) =>
  useQuery({
    queryKey: ["children", id],
    queryFn: async () =>
      (await get<{ things: ThingView[] }>(`/things?parent=${id ?? ""}&order=name&limit=500`)).things,
    enabled: id !== null,
  });

export const useSchema = () =>
  useQuery({ queryKey: ["schema"], queryFn: () => get<Schema>("/schema"), staleTime: 60_000 });

export const useTags = () =>
  useQuery({ queryKey: ["tags"], queryFn: async () => (await get<{ tags: TagInfo[] }>("/tags")).tags });

export const useTidy = () => useQuery({ queryKey: ["tidy"], queryFn: () => get<TidyData>("/tidy") });

export const useEvents = (limit = 30) =>
  useQuery({
    queryKey: ["events", limit],
    queryFn: async () => (await get<{ events: EventRow[] }>(`/events?limit=${limit}`)).events,
  });
