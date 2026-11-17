import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useKeyboard, usePaste } from "@opentui/react";
import { decodePasteBytes, type KeyEvent } from "@opentui/core";

// Keys go to one place at a time: the newest layer (a screen, or a modal on top of it). A
// screen that doesn't use a key lets it through to the global keys (tabs, ⌃K, undo, quit);
// a modal keeps everything. Text fields are handled here too (`useLine`), so a typed "m" is a
// letter while you type and "move" when you don't.

export type Key = KeyEvent;
type Handler = (k: Key) => boolean | void;
interface Layer {
  id: number;
  modal: boolean;
  keys: { current: Handler };
  paste: { current: ((text: string) => boolean | void) | undefined };
}

interface Router {
  push(l: Layer): () => void;
}
const Ctx = createContext<Router | null>(null);
let nextId = 1;

export function KeyRouter({
  global,
  onPaste,
  children,
}: {
  global: (k: Key) => void;
  onPaste?: (text: string) => void;
  children: ReactNode;
}) {
  const layers = useRef<Layer[]>([]);
  const globalRef = useRef(global);
  useLayoutEffect(() => {
    globalRef.current = global;
  });
  const [router] = useState<Router>(() => ({
    push(l) {
      layers.current.push(l);
      return () => {
        layers.current = layers.current.filter((x) => x.id !== l.id);
      };
    },
  }));
  useKeyboard((k) => {
    const top = layers.current.at(-1);
    const used = top ? top.keys.current(k) === true : false;
    if (!used && !top?.modal) globalRef.current(k);
  });
  usePaste((e) => {
    const text = decodePasteBytes(e.bytes);
    const top = layers.current.at(-1);
    if (top?.paste.current?.(text) === true) return;
    if (!top?.modal) onPaste?.(text);
  });
  return <Ctx.Provider value={router}>{children}</Ctx.Provider>;
}

/**
 * Take keys while mounted (and `active`). Return true for a key you used.
 * `modal`: nothing gets past you (palette, pickers, prompts).
 */
export function useKeys(
  handler: Handler,
  opts: { modal?: boolean; active?: boolean; paste?: (text: string) => boolean | void } = {},
) {
  const router = useContext(Ctx);
  const keys = useRef(handler);
  const paste = useRef(opts.paste);
  useLayoutEffect(() => {
    keys.current = handler;
    paste.current = opts.paste;
  });
  const active = opts.active ?? true;
  const modal = opts.modal ?? false;
  useEffect(() => {
    if (!router || !active) return;
    return router.push({ id: nextId++, modal, keys, paste });
  }, [router, active, modal]);
}

/** A key that types something (not a command, arrow or control key). */
export function printable(k: Key): string | null {
  if (k.ctrl || k.meta || k.option || k.super) return null;
  const s = k.name === "space" ? " " : k.sequence;
  // oxlint-disable-next-line no-control-regex
  if (!s || s.startsWith("\x1b") || /[\x00-\x1f\x7f]/.test(s)) return null;
  return s;
}

export const isEnter = (k: Key) => k.name === "return" || k.name === "enter" || k.name === "linefeed";
export const isUp = (k: Key) => k.name === "up" || (!k.ctrl && k.name === "k" && !k.shift);
export const isDown = (k: Key) => k.name === "down" || (!k.ctrl && k.name === "j" && !k.shift);

/** One line of editable text with a cursor. */
export interface Line {
  value: string;
  cursor: number;
  set(v: string): void;
  /** Use a key if it edits the line; true when used. */
  edit(k: Key): boolean;
  insert(s: string): void;
}

export function useLine(initial = ""): Line {
  const [st, setSt] = useState({ value: initial, cursor: initial.length });
  // The latest value, for keys that arrive before React re-renders.
  const ref = useRef(st);
  const put = (value: string, cursor: number) => {
    ref.current = { value, cursor: Math.max(0, Math.min(cursor, value.length)) };
    setSt(ref.current);
  };
  return {
    value: st.value,
    cursor: st.cursor,
    set: (v) => put(v, v.length),
    insert(s) {
      const { value, cursor } = ref.current;
      const clean = s.replace(/[\r\n]+/g, " ");
      put(value.slice(0, cursor) + clean + value.slice(cursor), cursor + clean.length);
    },
    edit(k) {
      const { value, cursor } = ref.current;
      const ch = printable(k);
      if (ch) {
        put(value.slice(0, cursor) + ch + value.slice(cursor), cursor + ch.length);
        return true;
      }
      switch (k.ctrl ? `C-${k.name}` : k.meta ? `M-${k.name}` : k.name) {
        case "backspace":
          if (cursor > 0) put(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
          return true;
        case "delete":
        case "C-d":
          put(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
          return true;
        case "left":
        case "C-b":
          put(value, cursor - 1);
          return true;
        case "right":
        case "C-f":
          put(value, cursor + 1);
          return true;
        case "home":
        case "C-a":
          put(value, 0);
          return true;
        case "end":
        case "C-e":
          put(value, value.length);
          return true;
        case "C-u":
          put(value.slice(cursor), 0);
          return true;
        case "C-w":
        case "M-backspace": {
          const before = value.slice(0, cursor).replace(/\S+\s*$/, "");
          put(before + value.slice(cursor), before.length);
          return true;
        }
        default:
          return false;
      }
    },
  };
}

/** For key handlers: do it, and say the key was used. */
export const used = (_?: unknown): true => true;
