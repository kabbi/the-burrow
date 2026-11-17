import { useApp, type Route } from "../state.tsx";
import { useTheme } from "../theme.ts";
import { L } from "../ui.tsx";
import { FindScreen } from "./Find.tsx";
import { ThingScreen } from "./Thing.tsx";

export function Screen({ route }: { route: Route }) {
  switch (route.s) {
    case "find":
      return <FindScreen />;
    case "thing":
      return <ThingScreen id={route.id} />;
    default:
      return <Soon what={route.s} />;
  }
}

function Soon({ what }: { what: string }) {
  const th = useTheme();
  const { w } = useApp().area;
  return <L w={w} segs={[{ t: `${what}: coming up`, fg: th.dim }]} />;
}
