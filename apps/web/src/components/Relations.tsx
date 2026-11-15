import { useState } from "react";
import { Link } from "react-router";
import { del, post, type ThingDetail } from "../lib/api.ts";
import { useAction } from "../lib/hooks.ts";
import { kindIs, useSchema } from "../lib/schema.ts";
import { useMe } from "../lib/auth.ts";
import { ThingSearch } from "./ThingSearch.tsx";

type Rel = ThingDetail["relations"][number];

/**
 * Typed links to other things, grouped by how they read from this side
 * ("accessories", "replaced by"…). Tags are shown separately.
 */
export function Relations({
  thingId,
  thingKind,
  relations,
}: {
  thingId: string;
  thingKind: string;
  relations: Rel[];
}) {
  const act = useAction();
  const { data: schema } = useSchema();
  const [choice, setChoice] = useState("");
  const [adding, setAdding] = useState(false);
  const shown = relations.filter((r) => r.type !== "tagged");
  const groups = new Map<string, Rel[]>();
  for (const r of shown) groups.set(r.label, [...(groups.get(r.label) ?? []), r]);

  const isA = (kind: string, allowed: string[]) =>
    !allowed.length || allowed.some((k) => kindIs(schema?.kinds ?? [], kind, k));
  // Each relation type can be added from either end: "accessory of →" or "← accessories", when
  // this thing may stand on that end (only a person "owns").
  const choices = (schema?.relations ?? [])
    .filter((rt) => rt.id !== "tagged")
    .flatMap((rt) =>
      rt.symmetric
        ? [{ key: `${rt.id}:out`, label: rt.name, ok: isA(thingKind, rt.fromKinds) }]
        : [
            { key: `${rt.id}:out`, label: rt.name, ok: isA(thingKind, rt.fromKinds) },
            { key: `${rt.id}:in`, label: rt.inverse, ok: isA(thingKind, rt.toKinds) },
          ],
    )
    .filter((c) => c.ok);
  const [type, direction] = (choice || choices[0]?.key || ":").split(":");
  // Only things the link type allows at the other end ("owned by" → people).
  const rt = schema?.relations.find((x) => x.id === type);
  const otherKinds = (direction === "in" ? rt?.fromKinds : rt?.toKinds) ?? [];
  const fits = (kind: string) => isA(kind, otherKinds);
  const me = useMe();
  const link = (otherId: string, name: string) =>
    act(() => post(`/things/${thingId}/relations`, { type, otherId, direction }), `Linked ${name}`);
  const linkedToMe = shown.some(
    (r) => r.type === type && r.direction === direction && r.other.id === me?.personId,
  );

  return (
    <div className="stack" style={{ gap: 10 }}>
      {shown.length === 0 && !adding && (
        <p className="muted small" style={{ margin: 0 }}>
          No links yet.
        </p>
      )}
      {[...groups].map(([label, rels]) => (
        <div key={label} className="fact" style={{ gridTemplateColumns: "130px 1fr" }}>
          <span className="label">{label}</span>
          <span className="row">
            {rels.map((r) => (
              <span key={r.edgeId} className="chip" style={{ minHeight: 30, paddingRight: 4 }}>
                <Link
                  to={r.paperlessId ? `/papers?doc=${r.paperlessId}` : `/t/${r.other.id}`}
                  style={{ color: "inherit", textDecoration: "none" }}
                >
                  {r.other.name}
                </Link>
                <button
                  type="button"
                  className="tagx"
                  aria-label={`Unlink ${r.other.name}`}
                  onClick={() =>
                    act(
                      () =>
                        del(`/things/${thingId}/relations`, {
                          type: r.type,
                          otherId: r.other.id,
                          direction: r.direction,
                        }),
                      `Unlinked ${r.other.name}`,
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </span>
        </div>
      ))}
      {!adding && (
        <button
          type="button"
          className="chip mini dashed"
          style={{ alignSelf: "flex-start" }}
          onClick={() => setAdding(true)}
        >
          + link to another thing
        </button>
      )}
      {adding && (
        <div className="row">
          <select
            className="input"
            style={{ width: "auto" }}
            value={choice || choices[0]?.key}
            onChange={(e) => setChoice(e.target.value)}
            aria-label="Link type"
          >
            {choices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <div className="grow" style={{ minWidth: 220 }}>
            <ThingSearch
              placeholder="link to…"
              autoFocus
              filter={(t) => t.id !== thingId && t.kind !== "tag" && fits(t.kind)}
              onPick={(t) => link(t.id, t.name)}
            />
          </div>
          {me && me.personId !== thingId && fits("person") && otherKinds.length > 0 && !linkedToMe && (
            <button type="button" className="chip" onClick={() => link(me.personId, me.name)}>
              me
            </button>
          )}
          <button type="button" className="btn small ghost" onClick={() => setAdding(false)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
