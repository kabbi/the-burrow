import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon.tsx";

/** A page's title, one line of what it is for, and its actions on the right. */
export function PageHead({
  title,
  lede,
  children,
}: {
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="pagehead">
      <div>
        <h1>{title}</h1>
        {lede && <p>{lede}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

/** A caps label over a section, with an optional link or note on the right. */
export function SecHead({ title, children, id }: { title: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <div className="sechead">
      <h2 className="eyebrow" id={id}>
        {title}
      </h2>
      {children}
    </div>
  );
}

/** Icon-only Right / Wrong for an unchecked AI guess. */
export function Verdict({
  onRight,
  onWrong,
  what,
}: {
  onRight: () => void;
  onWrong: () => void;
  what: string;
}) {
  return (
    <span className="verdict">
      <button type="button" onClick={onRight} aria-label={`Right: ${what}`} title="Right">
        <Icon name="check" size={16} stroke={2.6} />
      </button>
      <button type="button" onClick={onWrong} aria-label={`Wrong: ${what}`} title="Wrong">
        <Icon name="x" size={16} stroke={2.6} />
      </button>
    </span>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  run: () => void;
  hidden?: boolean;
}

/** The ⋯ button: rare actions (print label, archive) out of the way. */
export function Menu({ items, label = "More", big }: { items: MenuItem[]; label?: string; big?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const shown = items.filter((i) => !i.hidden);
  if (!shown.length) return null;
  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className={`btn quiet icon${big ? " big" : ""}`}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" size={20} stroke={3} />
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {shown.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                i.run();
              }}
            >
              {i.icon && <Icon name={i.icon} />}
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
