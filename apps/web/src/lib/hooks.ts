import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post, type BurrowEvent } from "./api.ts";
import { useToast } from "./toast.tsx";

export function useDebounced<T>(value: T, ms = 150): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Invalidate everything: the data set is small and consistency beats cleverness. */
export function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

/** Undo/redo an event, then refresh. */
export function useUndo() {
  const refresh = useRefresh();
  const toast = useToast();
  return useMutation({
    mutationFn: (seq: number) => post<{ event: BurrowEvent }>(`/events/${seq}/undo`),
    onSuccess: () => refresh(),
    onError: (e) => toast({ text: (e as Error).message, error: true }),
  });
}

/** Run a write, show a toast with Undo, refresh queries. */
export function useAction() {
  const refresh = useRefresh();
  const toast = useToast();
  const undo = useUndo();
  return async <T extends { event?: BurrowEvent }>(
    fn: () => Promise<T>,
    text: string | ((r: T) => string),
  ) => {
    try {
      const r = await fn();
      await refresh();
      const seq = r.event?.seq;
      toast({
        text: typeof text === "function" ? text(r) : text,
        ...(seq ? { action: { label: "Undo", run: () => undo.mutateAsync(seq).then(() => {}) } } : {}),
      });
      return r;
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
      return null;
    }
  };
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}
