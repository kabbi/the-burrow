// bun test/peek.tsx <cols> <rows> [keys…]: type keys ("text:ivar", "down", "enter", "esc", "tab", "ctrl+k") and print the frame.
import { draw } from "./harness.tsx";
const [w = "160", h = "40", ...keys] = process.argv.slice(2);
const d = await draw(Number(w), Number(h));
await d.settle(800);
for (const k of keys) {
  if (k.startsWith("text:")) await d.mockInput.typeText(k.slice(5));
  else if (k.startsWith("wait:")) await new Promise((r) => setTimeout(r, Number(k.slice(5))));
  else if (k.startsWith("ctrl+")) d.mockInput.pressKey(k.slice(5), { ctrl: true });
  else
    d.mockInput.pressKey(
      k === "enter"
        ? "RETURN"
        : k === "esc"
          ? "ESCAPE"
          : k === "tab"
            ? "TAB"
            : k === "down"
              ? "ARROW_DOWN"
              : k === "up"
                ? "ARROW_UP"
                : k === "left"
                  ? "ARROW_LEFT"
                  : k === "right"
                    ? "ARROW_RIGHT"
                    : k,
    );
  await d.settle(500);
}
console.log(d.frame());
await d.dispose();
process.exit(0);
