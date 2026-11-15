# Burrow design system

Live version: **Workshop › Design system** (`/workshop/system`, `apps/web/src/pages/System.tsx`),
drawn with the real parts. Source of the look: the "Burrow — unified design" canvas (D-027).

## Principles

1. **Fine is silent.** No status when nothing is wrong. A thing in its place shows its path, nothing else.
2. **Words first, colour agrees.** A status is a word with an icon; colour backs it up, never carries it alone.
3. **One orange per screen.** The thing you most likely came to do. Everything else is outlined or quiet.
4. **Act, then Undo.** No confirm dialogs. Do it, show a 10 s toast, keep it in history forever.
5. **Violet until a person agrees.** AI writes straight away, in violet, with Right / Wrong. Paid AI shows its price first.

## Where things live

| File                    | What                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/tokens.css`     | Every colour, font, radius and the gutter, as CSS variables. Nothing else defines colours.                                                                                                        |
| `src/ui/ui.css`         | Shared parts: shell (top bar, tab bar, sheet), page heads, buttons, chips / tags / pills / counts, forms, combobox, pictures, paths, the two nowheres, the thing row, tiles, jobs, toasts, menus. |
| `src/ui/Icon.tsx`       | Interface icons (24 px strokes, `currentColor`) and the Burrow mark. Thing pictures use MDI (D-022).                                                                                              |
| `src/ui/thing.tsx`      | `Thumb`, `PathView`, `Nowhere`, `Where`, `StatusPill`, `ThingRow`, `ThingTile`, `uncheckedAi`.                                                                                                    |
| `src/ui/parts.tsx`      | `PageHead`, `SecHead`, `Verdict` (✓ ✕), `Menu` (⋯).                                                                                                                                               |
| `src/ui/MovePicker.tsx` | Move anywhere, a new place, or "No fixed place".                                                                                                                                                  |
| `src/styles.css`        | Page-specific layout only. Uses tokens; must not invent colours.                                                                                                                                  |

## Colour: one meaning each

| Token                                      | Meaning       | Rule                                            |
| ------------------------------------------ | ------------- | ----------------------------------------------- |
| `--main` #B8401C                           | do this       | one per screen (`.btn.main`, the phone's + tab) |
| `--ink` #1C1B19                            | selected      | nav, pressed chips, selected rows               |
| `--ai` #5B3DF5 on `--ai-tint` / `--ai-row` | AI, unchecked | until a person confirms                         |
| `--bad` #B3261E on `--bad-tint`            | wrong         | missing, failed; red count only for missing     |
| `--warn` #8A5F00 on `--warn-tint`          | heads-up      | warranty soon, not checked lately               |
| `--ok` #2F6F5E on `--ok-tint`              | done          | only right after an action ("Saved as B-0224")  |

Neutrals: ground `--bg`, surface `--panel`, sunken `--sunk`, lines `--line` / `--line-2` (inputs) /
`--line-3` (row dividers), dashed `--dash` (gaps, pseudo-places, "+ add"), text `--ink-2`, `--muted`;
`--faint` is for separators only (fails contrast as text).

## Type

Space Grotesk for the page question (48), page and thing names (32–36), row names (600 · 18).
Inter for everything else (15 body; 12 caps labels via `.eyebrow`). JetBrains Mono for IDs, slugs,
money, counts and keys (`.mono`, `.idtext`, `.idbadge`, `.count`).

## Parts and when to use them

- **Buttons**: `.btn.main` (orange, one) · `.btn` (outlined in ink: secondary) · `.btn.quiet`
  (outlined in line: tertiary) · `.btn.ghost` (text) · `.btn.ai` (violet; `.solid` for "All right").
  Sizes `.small` (36), default (44), `.big` (48); `.icon` for square icon buttons with `aria-label`.
  No red buttons: deleting is archiving.
- **Chip** = you tap it (filters, choices; pressed is ink). **Tag** = a label (the kind). **Pill** = a
  status, only when not fine (`StatusPill`). **Count** = neutral number; `.ntile` starts a job row.
- **The thing row** (`ThingRow`): picture · name + ID · where · optional "why" line · status pill ·
  actions (on hover with a mouse, always on touch). Grids use `ThingTile`.
- **Where it is**: rows show "Room › … › Last step" (last step bold, spot after a dot); the thing page
  uses `chips`. Two nowheres (D-026): `Not placed yet` (dashed, a gap) and `No fixed place` (sunken,
  bag icon).
- **Jobs** (`.job` in `.rows`): count tile, title, one grey line of why, one action. Find and Tidy up.
- **Auto groups**: 12+ alike results (same kind) fold into one row with a stack picture and a "why"
  line; they open by themselves when they are the only result. Search only, for now.
- **AI guesses**: violet label with a filled sparkle, violet value, borderless ✓ ✕ icons (`Verdict`); "All right" in the panel header.
- **Thing of the day** (D-028): one card on Find with one nudge and at most two actions plus "Another one".
- **Fewer buttons**: a row that is a link has no button inside; rare actions fold behind one line or ⋯.
- **Feedback**: toasts bottom left (above the tab bar on phones), 10 s, grouped repeats share one
  Undo (`useAction` `group`, `useBulk` for many writes).

## Layout

- Desktop: sticky top bar (logo, small search except on Find, nav Find · Places · Papers · Tidy up ·
  Workshop, "Add a thing"). Pages `main.page` (1240), `.wide` (1400), `.narrow` (1080).
- Phones (≤ 720 px): no top bar; a bottom tab bar Find · Places · **+** · Tidy · More. More opens a
  sheet with Papers and the Workshop pages. Pages leave room for the tab bar.
- Workshop pages share a side nav (a scrolling chip row under 900 px).
- Touch targets ≥ 44 px; real buttons, links and labels; icons inside labelled buttons are `aria-hidden`.
