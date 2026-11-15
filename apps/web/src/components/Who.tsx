import { Link } from "react-router";
import { useActors } from "../lib/auth.ts";

/** Who did it: a person (links to their page), AI, an app or Burrow itself (D-032). */
export function Who({ actor }: { actor: string }) {
  const who = useActors()(actor);
  return who.personId ? (
    <Link to={`/t/${who.personId}`} title={who.title} className="who">
      {who.label}
    </Link>
  ) : (
    <span title={who.title} className={who.kind === "app" ? "mono" : undefined}>
      {who.label}
    </span>
  );
}
