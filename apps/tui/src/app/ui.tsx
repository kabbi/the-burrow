import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { ThingView } from "../api.ts";
import { cut, fit, width } from "../text.ts";
import { useTheme, type Theme } from "./theme.ts";

// The few parts every screen is drawn with: a line of styled segments, panes, keycaps, hints.

export interface Seg {
  t: string;
  fg?: string;
  bg?: string;
  b?: boolean;
  u?: boolean;
  href?: string;
}

const attrs = (s: Seg) => (s.b ? TextAttributes.BOLD : 0) | (s.u ? TextAttributes.UNDERLINE : 0);

/**
 * One line of text. With `w` it is cut / padded to exactly that many cells (a selected row
 * fills its whole width in inverse video).
 */
export function L({
  segs,
  w,
  sel,
  bg,
  onClick,
}: {
  segs: (Seg | string | false | null | undefined)[];
  w?: number;
  sel?: boolean;
  bg?: string;
  /** Mouse (and taps in the web terminal): select, or open when already selected. */
  onClick?: () => void;
}) {
  const th = useTheme();
  let parts = segs
    .filter((s): s is Seg | string => Boolean(s))
    .map((s) => (typeof s === "string" ? { t: s } : s));
  if (w !== undefined) {
    const out: Seg[] = [];
    let left = w;
    for (const s of parts) {
      if (left <= 0) break;
      const t = width(s.t) > left ? cut(s.t, left) : s.t;
      out.push({ ...s, t });
      left -= width(t);
    }
    if (left > 0) out.push({ t: " ".repeat(left) });
    parts = out;
  }
  return (
    <text
      wrapMode="none"
      {...(sel ? { bg: th.selBg } : bg ? { bg } : {})}
      {...(onClick ? { onMouseDown: onClick } : {})}
    >
      {parts.map((s, i) => (
        <span
          key={i}
          fg={sel ? th.selFg : (s.fg ?? th.fg)}
          {...(sel ? { bg: th.selBg } : s.bg ? { bg: s.bg } : {})}
          attributes={attrs(s)}
          {...(s.href ? { link: { url: s.href } } : {})}
        >
          {s.t}
        </span>
      ))}
    </text>
  );
}

/** A keycap: ⏎, ⌃K, u … */
export const kc = (th: Theme, k: string): Seg => ({ t: ` ${k} `, bg: th.key, fg: th.fg });
/** The violet keycap of an AI guess's "y". */
export const kcAi = (th: Theme, k: string): Seg => ({
  t: ` ${k} `,
  bg: th.ai,
  fg: th.bg === "transparent" ? th.selFg : th.bg,
});

/** Key hints: "⏎ open  m move  …", cut to the width. */
export function Hints({ items, w }: { items: [string, string][]; w: number }) {
  const th = useTheme();
  const segs: Seg[] = [];
  let used = 0;
  for (const [k, label] of items) {
    const n = width(k) + 2 + 1 + width(label) + 2;
    if (used + n > w) break;
    segs.push(kc(th, k), { t: ` ${label}  `, fg: th.dim });
    used += n;
  }
  return <L segs={segs} />;
}

export function Pane({
  title,
  focused,
  children,
  right,
  onWheel,
  ...box
}: {
  title?: string;
  focused?: boolean;
  right?: string;
  children?: ReactNode;
  width?: number | `${number}%` | "auto";
  height?: number | `${number}%` | "auto";
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: number;
  minWidth?: number;
  minHeight?: number;
  paddingLeft?: number;
  paddingRight?: number;
  onMouseDown?: () => void;
  /** Wheel: -1 up, 1 down. */
  onWheel?: (dir: number) => void;
}) {
  const th = useTheme();
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={focused ? th.focus : th.line}
      {...(title ? { title: ` ${title} `, titleColor: focused ? th.fg : th.dim } : {})}
      {...(right ? { bottomTitle: ` ${right} `, bottomTitleAlignment: "right" as const } : {})}
      flexDirection="column"
      paddingLeft={box.paddingLeft ?? 1}
      paddingRight={box.paddingRight ?? 1}
      {...(onWheel
        ? {
            onMouseScroll: (e: { scroll?: { direction: string } }) =>
              onWheel(e.scroll?.direction === "up" ? -1 : 1),
          }
        : {})}
      {...box}
    >
      {children}
    </box>
  );
}

/** A rule with a label: "── Missing ─────────". */
export function Rule({ label, w }: { label: string; w: number }) {
  const th = useTheme();
  const head = `── ${label} `;
  return <L segs={[{ t: head + "─".repeat(Math.max(0, w - width(head))), fg: th.dim }]} />;
}

/** Status as a glyph + word; nothing loud when it's fine. */
export function stateSeg(th: Theme, t: Pick<ThingView, "status">, words = false): Seg {
  if (t.status === "missing") return { t: words ? "✗ missing" : "✗", fg: th.bad };
  if (t.status === "unverified") return { t: words ? "▲ check" : "▲", fg: th.warn };
  return { t: words ? "● ok" : "●", fg: th.ok };
}

/** Fields an AI filled that nobody has confirmed yet (shown violet with ✦). */
export function uncheckedAi(t: ThingView): string[] {
  return Object.entries(t.meta)
    .filter(([, m]) => m.source === "ai" && !m.confirmed)
    .map(([k]) => k);
}

/** Visible slice of a list that keeps `sel` on screen. */
export function windowOf<T>(items: T[], sel: number, rows: number): { start: number; items: T[] } {
  if (rows <= 0) return { start: 0, items: [] };
  const start = Math.max(0, Math.min(sel - Math.floor(rows / 2), items.length - rows));
  return { start, items: items.slice(start, start + rows) };
}

export function Empty({ text, w }: { text: string; w: number }) {
  const th = useTheme();
  return <L segs={[{ t: fit(text, w), fg: th.dim }]} />;
}
