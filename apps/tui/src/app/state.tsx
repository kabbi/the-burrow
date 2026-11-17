import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { BurrowEvent, Me, ThingView } from "../api.ts";
import type { MoveTarget } from "./modals.tsx";

// What every screen can reach: where we are, who we are, the area to draw in, and the
// app-wide actions (writes with an Undo toast, the move picker, prompts, the clipboard).

export type Route =
  | { s: "find" }
  | { s: "add" }
  | { s: "places"; at?: string }
  | { s: "tags" }
  | { s: "needs" }
  | { s: "papers" }
  | { s: "db" }
  | { s: "ai" }
  | { s: "thing"; id: string };

export type Tab = Exclude<Route["s"], "thing">;
export const TABS: [Tab, string][] = [
  ["find", "Find"],
  ["add", "Add"],
  ["places", "Places"],
  ["tags", "Tags"],
  ["needs", "Needs"],
  ["papers", "Papers"],
  ["db", "DB"],
  ["ai", "AI"],
];

/** Enough of a thing to move it. */
export type Movable = Pick<ThingView, "id" | "name">;

export type Written = { event?: BurrowEvent; events?: BurrowEvent[] };

export interface Command {
  title: string;
  /** The key that does the same, shown in the palette ("the palette is the help"). */
  key?: string;
  section: string;
  /** Extra words to match. */
  also?: string;
  run(): void;
}

/** Layout by terminal width (System artboard): wide ≥ 140, medium 100–139, narrow 60–99, tiny < 60. */
export type Size = "wide" | "medium" | "narrow" | "tiny";
export const sizeOf = (w: number): Size =>
  w >= 140 ? "wide" : w >= 100 ? "medium" : w >= 60 ? "narrow" : "tiny";

export interface App {
  me: Me | null;
  url: string;
  /** The terminal is a browser tab (the web app's terminal mode). */
  remote: boolean;
  route: Route;
  /** The area a screen draws in, and its layout class. */
  area: { w: number; h: number; size: Size };
  go(r: Route): void;
  back(): void;
  /** Run a write, refresh, and show a toast whose Undo reverts what it did. */
  act<T extends Written>(
    fn: () => Promise<T>,
    text: string | ((r: T) => string),
    opts?: { group?: string },
  ): Promise<T | undefined>;
  toast(text: string, kind?: "ok" | "error" | "info"): void;
  /** Pick a place for these things, then move them (one toast, one Undo). */
  move(things: Movable[]): void;
  /** Move these straight to a place you already know (one toast, one Undo). */
  moveTo(things: Movable[], to: MoveTarget): void;
  /** Choose a place (the move picker without moving anything). */
  pickPlace(title: string, onPick: (t: MoveTarget) => void): void;
  prompt(p: { title: string; initial?: string; hint?: string; onSubmit(value: string): void }): void;
  copy(text: string, what?: string): void;
  /** Link to this thing in the web app. */
  webUrl(path: string): string;
}

export const AppCtx = createContext<App | null>(null);
export function useApp(): App {
  const a = useContext(AppCtx);
  if (!a) throw new Error("useApp outside the app");
  return a;
}

/** Commands and key hints the current screen offers (palette, bottom line). */
export interface ScreenInfo {
  commands: Command[];
  hints: [string, string][];
}

/** The current screen's info; the hints line subscribes, the palette reads it when it opens. */
export class ScreenStore {
  info: ScreenInfo = { commands: [], hints: [] };
  private key = "";
  private snap: [string, string][] = [];
  private subs = new Set<() => void>();
  set(info: ScreenInfo) {
    this.info = info;
    const key = JSON.stringify(info.hints);
    if (key === this.key) return;
    this.key = key;
    this.snap = info.hints;
    for (const f of this.subs) f();
  }
  subscribe = (f: () => void) => {
    this.subs.add(f);
    return () => void this.subs.delete(f);
  };
  hints = () => this.snap;
}
export const ScreenCtx = createContext(new ScreenStore());

export function useScreen(info: ScreenInfo) {
  const store = useContext(ScreenCtx);
  useEffect(() => store.set(info));
}

export function Provide({ app, children }: { app: App; children: ReactNode }) {
  return <AppCtx.Provider value={app}>{children}</AppCtx.Provider>;
}
