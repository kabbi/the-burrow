import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface Toast {
  id: number;
  text: string;
  error?: boolean;
  action?: { label: string; run: () => void | Promise<void> };
}

const Ctx = createContext<(t: Omit<Toast, "id">) => void>(() => {});

let next = 1;

/** Toasts stay 10 s (design: "Undo after every move"); undo is also in history. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = next++;
    setToasts((xs) => [...xs.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.error ? 6000 : 10_000);
  }, []);
  const close = (id: number) => setToasts((xs) => xs.filter((x) => x.id !== id));
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
