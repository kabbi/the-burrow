import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

interface Toast {
  id: number;
  text: string;
  error?: boolean;
  /** A toast with the same key replaces the shown one (and restarts its timer) instead of stacking. */
  key?: string;
  action?: { label: string; run: () => void | Promise<void> };
}

const Ctx = createContext<(t: Omit<Toast, "id">) => void>(() => {});

let next = 1;

/** Toasts stay 10 s (design: "Undo after every move"); undo is also in history. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const close = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((xs) => xs.filter((x) => x.id !== id));
  }, []);
  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = next++;
      setToasts((xs) => {
        const same = t.key ? xs.find((x) => x.key === t.key) : undefined;
        if (same) {
          clearTimeout(timers.current.get(same.id));
          timers.current.delete(same.id);
          return xs.map((x) => (x === same ? { ...t, id } : x));
        }
        return [...xs.slice(-2), { ...t, id }];
      });
      timers.current.set(
        id,
        setTimeout(() => close(id), t.error ? 6000 : 10_000),
      );
    },
    [close],
  );
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? " error" : ""}`}>
            <span className="grow">{t.text}</span>
            {t.action && (
              <button
                type="button"
                onClick={async () => {
                  close(t.id);
                  await t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" aria-label="Dismiss" onClick={() => close(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
