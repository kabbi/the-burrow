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

/**
 * Rapid similar actions (confirming five AI guesses in a row) share one toast: each one
 * adds its item, and the toast's Undo reverts them all, newest first.
 */
export interface ActionGroup {
  key: string;
  text: (items: string[]) => string;
}
const groups = new Map<string, { items: string[]; seqs: number[]; until: number }>();
const GROUP_MS = 10_000;

/** Run a write, show a toast with Undo, refresh queries. */
export function useAction() {
  const refresh = useRefresh();
  const toast = useToast();
  const undo = useUndo();
  return async <T extends { event?: BurrowEvent; events?: BurrowEvent[] }>(
    fn: () => Promise<T>,
    text: string | ((r: T) => string),
    opts: { group?: ActionGroup } = {},
  ) => {
    try {
      const r = await fn();
      await refresh();
      const seq = r.event?.seq;
      const item = typeof text === "function" ? text(r) : text;
      const g = opts.group;
      if (g) {
        const now = Date.now();
        const prev = groups.get(g.key);
        const cur =
          prev && prev.until > now
            ? { items: [...prev.items, item], seqs: [...prev.seqs], until: now + GROUP_MS }
            : { items: [item], seqs: [] as number[], until: now + GROUP_MS };
        if (seq) cur.seqs.push(seq);
        groups.set(g.key, cur);
        const seqs = cur.seqs;
        toast({
          key: g.key,
          text: g.text(cur.items),
          ...(seqs.length
            ? {
                action: {
                  label: "Undo",
                  run: async () => {
                    groups.delete(g.key);
                    for (const s of [...seqs].reverse()) await undo.mutateAsync(s);
                  },
                },
              }
            : {}),
        });
        return r;
      }
      // A few events at once (a split, a combine): Undo reverts them all, newest first.
      const seqs = r.events?.map((e) => e.seq) ?? (seq ? [seq] : []);
      toast({
        text: item,
        ...(seqs.length
          ? {
              action: {
                label: "Undo",
                run: async () => {
                  for (const s of seqs.toReversed()) await undo.mutateAsync(s);
                },
              },
            }
          : {}),
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

/**
 * Run many writes as one action (Tidy up's "put these 22 in a box"): one refresh, one toast,
 * and its Undo reverts every event, newest first.
 */
export function useBulk() {
  const refresh = useRefresh();
  const toast = useToast();
  const undo = useUndo();
  return async (fns: (() => Promise<{ event?: BurrowEvent; events?: BurrowEvent[] }>)[], text: string) => {
    const seqs: number[] = [];
    let failed = 0;
    for (const fn of fns) {
      try {
        const r = await fn();
        if (r.event?.seq) seqs.push(r.event.seq);
        for (const e of r.events ?? []) seqs.push(e.seq);
      } catch {
        failed++;
      }
    }
    await refresh();
    toast({
      text: failed ? `${text} · ${failed} failed` : text,
      ...(failed && !seqs.length ? { error: true } : {}),
      ...(seqs.length
        ? {
            action: {
              label: "Undo",
              run: async () => {
                for (const s of seqs.toReversed()) await undo.mutateAsync(s);
              },
            },
          }
        : {}),
    });
  };
}
