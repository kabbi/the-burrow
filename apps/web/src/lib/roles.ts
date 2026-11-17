import type { AssetRole } from "@burrow/core/types";

/** What each asset role is called in the interface (also used by the TUI, D-037). */
export const ROLE_LABEL: Record<AssetRole, string> = {
  photo: "Our photo",
  product: "Shop photo",
  icon: "Icon",
  sprite: "2D art",
  model: "3D model",
  other: "Other",
};
