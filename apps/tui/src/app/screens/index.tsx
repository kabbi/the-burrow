import type { Route } from "../state.tsx";
import { AddScreen } from "./Add.tsx";
import { DbScreen } from "./Db.tsx";
import { FindScreen } from "./Find.tsx";
import { AiScreen, NeedsScreen, PapersScreen, TagsScreen } from "./Lists.tsx";
import { PlacesScreen } from "./Places.tsx";
import { ThingScreen } from "./Thing.tsx";

export function Screen({ route }: { route: Route }) {
  switch (route.s) {
    case "find":
      return <FindScreen />;
    case "add":
      return <AddScreen />;
    case "places":
      return <PlacesScreen />;
    case "tags":
      return <TagsScreen />;
    case "needs":
      return <NeedsScreen />;
    case "papers":
      return <PapersScreen />;
    case "db":
      return <DbScreen />;
    case "ai":
      return <AiScreen />;
    case "thing":
      return <ThingScreen id={route.id} />;
  }
}
