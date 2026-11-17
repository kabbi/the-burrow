// bun test/peek.tsx <cols> <rows> [keys…]: press keys and print the frame. Keys: "text:ivar",
// "wait:500", "ctrl+k", and names: enter esc tab space up down left right backspace, or a character.
import { draw } from "./harness.tsx";

const NAMES: Record<string, string> = {
  enter: "RETURN",
  esc: "ESCAPE",
  tab: "TAB",
  space: " ",
  up: "ARROW_UP",
  down: "ARROW_DOWN",
  left: "ARROW_LEFT",
  right: "ARROW_RIGHT",
  backspace: "BACKSPACE",
};

const [w = "160", h = "40", ...keys] = process.argv.slice(2);
const d = await draw(Number(w), Number(h));
await d.settle(800);
for (const k of keys) {
  if (k.startsWith("text:")) await d.mockInput.typeText(k.slice(5));
  else if (k.startsWith("wait:")) await new Promise((r) => setTimeout(r, Number(k.slice(5))));
  else if (k.startsWith("ctrl+")) d.mockInput.pressKey(k.slice(5), { ctrl: true });
  else d.mockInput.pressKey(NAMES[k] ?? k);
  await d.settle(450);
}
console.log(d.frame());
await d.dispose();
process.exit(0);
