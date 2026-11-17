import { createContext, useContext } from "react";

// The web app's colour meanings on a character grid (D-027, D-037). Each colour also has a
// glyph, so nothing relies on colour alone: ● ok · ▲ heads-up · ✗ wrong · ✦ AI guess.
// Selection is inverse video (the web's "ink = selected"); the focused pane has a bright border.

export interface Theme {
  name: "dark" | "light" | "mono";
  bg: string;
  fg: string;
  dim: string;
  ok: string;
  warn: string;
  bad: string;
  ai: string;
  /** The one main action on a screen. */
  main: string;
  onMain: string;
  line: string;
  focus: string;
  /** Keycaps and the "trail" (the path walked in Places columns). */
  key: string;
  link: string;
  bar: string;
  selBg: string;
  selFg: string;
}

export const DARK: Theme = {
  name: "dark",
  bg: "#0e1014",
  fg: "#dfe2e8",
  dim: "#8b93a3",
  ok: "#7bd88f",
  warn: "#f0c05a",
  bad: "#ff7a7a",
  ai: "#c4a3ff",
  main: "#ff9447",
  onMain: "#0e1014",
  line: "#2b303b",
  focus: "#c9ced8",
  key: "#262a33",
  link: "#8fb8ff",
  bar: "#181b22",
  selBg: "#dfe2e8",
  selFg: "#0e1014",
};

/** From the web app's tokens (apps/web/src/ui/tokens.css). */
export const LIGHT: Theme = {
  name: "light",
  bg: "#f4f1ea",
  fg: "#1c1b19",
  dim: "#6b655a",
  ok: "#2f6f5e",
  warn: "#8a5f00",
  bad: "#b3261e",
  ai: "#5b3df5",
  main: "#b8401c",
  onMain: "#ffffff",
  line: "#d6cdbb",
  focus: "#4a453d",
  key: "#e2dacb",
  link: "#1f5fbf",
  bar: "#ede8dd",
  selBg: "#1c1b19",
  selFg: "#f4f1ea",
};

/** NO_COLOR: one ink on the terminal's own background; glyphs, bold and inverse carry meaning. */
export function mono(dark: boolean): Theme {
  const fg = dark ? "#e0e0e0" : "#202020";
  const bg = "transparent";
  return {
    name: "mono",
    bg,
    fg,
    dim: fg,
    ok: fg,
    warn: fg,
    bad: fg,
    ai: fg,
    main: fg,
    onMain: dark ? "#000000" : "#ffffff",
    line: fg,
    focus: fg,
    key: bg,
    link: fg,
    bar: bg,
    selBg: fg,
    selFg: dark ? "#000000" : "#ffffff",
  };
}

export function pickTheme(mode: "dark" | "light" | null, env = process.env): Theme {
  const forced = env.BURROW_THEME;
  const dark = forced ? forced !== "light" : mode !== "light";
  if (env.NO_COLOR) return mono(dark);
  return dark ? DARK : LIGHT;
}

export const ThemeCtx = createContext<Theme>(DARK);
export const useTheme = () => useContext(ThemeCtx);
