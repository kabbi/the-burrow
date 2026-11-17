import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  aiInput,
  get,
  isUrl,
  pageData,
  patch,
  post,
  type BurrowEvent,
  type EventRow,
  type Hits,
  type Preview,
  type ThingView,
} from "../../api.ts";
import { cut, fit, foldPath, plural, SEP, whereText, width } from "../../text.ts";
import { stepText, useAiOptions, useSuggest } from "../ai.ts";
import { usePlaces, useSchema, useThing } from "../data.ts";
import { isEnter, useKeys, useLine, used } from "../keys.tsx";
import { LineView } from "../modals.tsx";
import { useApp, useScreen, type Command } from "../state.tsx";
import { useTheme } from "../theme.ts";
import { kc, kcAi, L, Pane, uncheckedAi, type Seg } from "../ui.tsx";

// Add a thing: a name is enough. Recent places, kind chips, a visible spot field, a warning
// when you already have one, and AI suggestions in "Just saved" (a local model starts by
// itself; a paid one shows its price first). AI tags stay folded until you look.

const FIELDS = ["name", "where", "spot", "kind", "qty"] as const;
type Field = (typeof FIELDS)[number];

const normName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

interface Saved {
  thing: ThingView;
  input: Record<string, unknown>;
}

/** The places you put things in lately (your own creates and moves), newest first. */
function useRecentPlaces(me: string | null) {
  return useQuery({
    queryKey: ["recent-places", me],
    queryFn: async () => {
      const { events } = await get<{ events: EventRow[] }>(
        "/events?types=thing.created,thing.moved&limit=80",
      );
      const ids: string[] = [];
      for (const e of events as (EventRow & { body: BurrowEvent["body"] })[]) {
        if (me && e.actor !== me) continue;
        const b = e.body;
        const id = b.type === "thing.created" ? b.parentId : b.type === "thing.moved" ? b.to : null;
        if (id && !ids.includes(id)) ids.push(id);
      }
      return ids;
    },
  });
}

export function AddScreen() {
  const app = useApp();
  const th = useTheme();
  const { w, h, size } = app.area;
  const name = useLine();
  const spot = useLine();
  const [field, setField] = useState<Field>("name");
  const [placeId, setPlaceId] = useState<string | null | undefined>(undefined);
  const [kind, setKind] = useState("thing");
  const [qty, setQty] = useState(1);
  const [link, setLink] = useState<{ url: string; page: Preview | null } | null>(null);
  const [session, setSession] = useState<Saved[]>([]);
  const [saving, setSaving] = useState(false);
  const { data: places = [] } = usePlaces();
  const { data: recent = [] } = useRecentPlaces(app.me?.username ?? null);
  const { data: schema } = useSchema();
  // People are added from the account page (D-032), not here.
  const kinds = (schema?.kinds ?? [])
    .filter((k) => !k.isTag && !k.isDocument && k.id !== "person")
    .map((k) => k.id);
  const orderedKinds = ["thing", ...kinds.filter((k) => k !== "thing")];
  const byId = new Map(places.map((p) => [p.id, p]));
  const recentPlaces = recent.filter((id) => byId.has(id)).slice(0, 3);
  // Where the next thing goes: what you picked, else where you put things last.
  const where = placeId === undefined ? (recentPlaces[0] ?? null) : placeId;
  const wherePath = where ? (byId.get(where)?.path ?? where) : null;

  const typed = name.value.trim();
  const { data: dupHits } = useQuery({
    queryKey: ["search", typed],
    queryFn: () => get<Hits>(`/search?q=${encodeURIComponent(typed)}&limit=20`),
    enabled: typed.length >= 3 && !isUrl(typed),
  });
  const dups = (dupHits?.hits ?? []).map((x) => x.thing).filter((t) => normName(t.name) === normName(typed));

  const last = session[0] ?? null;
  const { data: lastDetail } = useThing(last?.thing.id ?? null);
  const lastThing = lastDetail?.thing ?? last?.thing;
  const ai = useAiOptions();
  const suggest = useSuggest(lastThing);

  async function readLink(url: string) {
    setLink({ url, page: null });
    app.toast("Reading the page…");
    const r = await post<{ preview: Preview | null; error?: string }>("/preview", { url }).catch(
      (e: Error) => ({
        preview: null,
        error: e.message,
      }),
    );
    setLink({ url, page: r.preview });
    if (r.preview?.title && !name.value.trim()) name.set(r.preview.title);
    app.toast(
      r.preview
        ? `Read ${r.preview.siteName ?? "the page"}`
        : `Couldn't read that page${r.error ? `: ${r.error}` : ""}`,
    );
  }

  async function save() {
    if (saving) return;
    const n = typed;
    if (!n) return app.toast("A name is enough, but it's needed");
    if (isUrl(n)) return void readLink(n);
    setSaving(true);
    const data: Record<string, unknown> = {};
    const sources: Record<string, string> = {};
    if (link) {
      data.url = link.url;
      sources.url = "you";
      if (link.page) {
        for (const [k, v] of Object.entries(pageData(link.page))) {
          data[k] = v;
          sources[k] = "page";
        }
        if (link.page.title === n) sources.name = "page";
      }
    }
    if (qty > 1) data.quantity = qty;
    const pos = spot.value.trim();
    const r = await app.act(
      async () => {
        const c = await post<{ thing: ThingView; event: BurrowEvent }>("/things", {
          name: n,
          kind,
          parentId: where,
          data,
          source: "you",
          sources,
        });
        const events = [c.event];
        let thing = c.thing;
        if (where && pos) {
          const m = await post<{ thing: ThingView; event?: BurrowEvent }>(`/things/${thing.id}/move`, {
            to: where,
            position: pos,
          });
          thing = m.thing;
          if (m.event) events.push(m.event);
        }
        if (link?.page?.image)
          await post(`/things/${thing.id}/assets/from-url`, { url: link.page.image, role: "product" }).catch(
            () => {},
          );
        return { thing, events };
      },
      (x) => `Saved as ${x.thing.id}${where ? ` in ${byId.get(where)?.name ?? where}` : " (not placed yet)"}`,
    );
    setSaving(false);
    if (!r) return;
    const input = aiInput(n, link?.url ?? null, link?.page ?? null);
    setSession((s) => [{ thing: r.thing, input }, ...s].slice(0, 30));
    // A free local model fills in details by itself; a paid one waits for "s" (and shows its price).
    if (ai.preferred && !ai.preferred.paid) void suggest.start(ai.preferred, input, r.thing);
    name.set("");
    spot.set("");
    setQty(1);
    setLink(null);
    setField("name");
  }

  const oneMore = (t: ThingView) =>
    void app
      .act(
        () => patch(`/things/${t.id}`, { data: { quantity: (Number(t.data.quantity) || 1) + 1 } }),
        `${t.name}: now ${(Number(t.data.quantity) || 1) + 1}`,
      )
      .then((r) => r && name.set(""));
  const pickPlace = () =>
    app.pickPlace("Put it in…", (t) => {
      setPlaceId(t.to);
      if (t.position) spot.set(t.position);
    });
  const guesses = lastThing ? uncheckedAi(lastThing) : [];
  const aiTags = lastThing?.tags.filter((g) => g.source === "ai") ?? [];
  const allRight = () =>
    lastThing &&
    (guesses.length || aiTags.length) &&
    void app.act(
      async () => {
        if (guesses.length) await post(`/things/${lastThing.id}/confirm`, { fields: guesses });
        for (const g of aiTags) await post(`/things/${lastThing.id}/tags/${g.id}/confirm`);
        return {};
      },
      `All right (${guesses.length + aiTags.length})`,
    );
  const allWrong = () =>
    lastThing &&
    guesses.length &&
    void app.act(
      () =>
        patch(`/things/${lastThing.id}`, {
          data: Object.fromEntries(guesses.filter((k) => k !== "name" && k !== "kind").map((k) => [k, null])),
        }),
      `Removed ${plural(guesses.length, "guess", "guesses")}`,
    );

  const commands: Command[] = [
    { section: "Add", title: "Save", key: "⏎", run: () => void save() },
    { section: "Add", title: "Pick the place", key: "⌃P", run: pickPlace },
    { section: "Add", title: "Not placed yet", run: () => setPlaceId(null) },
    ...(dups[0]
      ? [
          {
            section: "Add",
            title: `One more ${dups[0].name} (${dups[0].id})`,
            key: "⌃Y",
            run: () => oneMore(dups[0]!),
          },
        ]
      : []),
    ...(lastThing
      ? [
          {
            section: "Just saved",
            title: `Open ${lastThing.name}`,
            key: "⌃O",
            run: () => app.go({ s: "thing", id: lastThing.id }),
          },
          { section: "Just saved", title: "AI guesses: all right", key: "Y", run: allRight },
          ...ai.options.map((o) => ({
            section: "Just saved",
            title: `Suggest details · ${o.label}`,
            also: "ai",
            run: () => void suggest.start(o, last?.input),
          })),
        ]
      : []),
  ];
  useScreen({
    commands,
    hints:
      suggest.step.s === "quoted"
        ? [
            ["⏎", "run (paid)"],
            ["esc", "cancel"],
          ]
        : [
            ["⏎", "save"],
            ["tab", "field"],
            ...(field === "where" ? ([["1-3", "recent place"]] as [string, string][]) : []),
            ...(field === "kind" || field === "qty" ? ([["←→", "change"]] as [string, string][]) : []),
            ["⌃P", "pick place"],
            ["⌃V", "paste a link"],
            ...(guesses.length && !typed ? ([["Y", "all right"]] as [string, string][]) : []),
            ["esc", "leave"],
          ],
  });

  useKeys(
    (k) => {
      if (suggest.step.s === "quoted") {
        if (isEnter(k)) return used(suggest.run(suggest.step.quote));
        if (k.name === "escape") return used(suggest.reset());
      }
      if (isEnter(k)) return used(save());
      if (k.name === "tab" || k.name === "down" || k.name === "up") {
        const i = FIELDS.indexOf(field);
        const d = k.shift || k.name === "up" ? -1 : 1;
        return used(setField(FIELDS[(i + d + FIELDS.length) % FIELDS.length]!));
      }
      if (k.ctrl && k.name === "p") return used(pickPlace());
      if (k.ctrl && k.name === "y" && dups[0]) return used(oneMore(dups[0]));
      if (k.ctrl && k.name === "o" && (dups[0] || lastThing))
        return used(app.go({ s: "thing", id: (dups[0] ?? lastThing)!.id }));
      if (k.name === "escape") {
        if (typed || spot.value) {
          name.set("");
          spot.set("");
          setLink(null);
          return true;
        }
        return false;
      }
      if (field === "name") {
        if (!typed && k.sequence === "Y" && lastThing) return used(allRight());
        if (!typed && k.sequence === "N" && lastThing) return used(allWrong());
        if (!typed && k.sequence === "s" && lastThing) return used(suggest.start(ai.preferred, last?.input));
        return name.edit(k);
      }
      if (field === "spot") return spot.edit(k);
      if (field === "where") {
        const n = Number(k.sequence);
        if (n >= 1 && n <= recentPlaces.length) return used(setPlaceId(recentPlaces[n - 1]!));
        if (k.sequence === "0" || k.name === "backspace") return used(setPlaceId(null));
        if (isEnter(k) || k.sequence === " ") return used(pickPlace());
        return Boolean(k.sequence && /^[a-z]$/i.test(k.sequence));
      }
      if (field === "kind") {
        const i = Math.max(0, orderedKinds.indexOf(kind));
        if (k.name === "right" || k.sequence === "l")
          return used(setKind(orderedKinds[(i + 1) % orderedKinds.length]!));
        if (k.name === "left" || k.sequence === "h")
          return used(setKind(orderedKinds[(i - 1 + orderedKinds.length) % orderedKinds.length]!));
        // Type the first letters of a kind to jump to it.
        if (k.sequence && /^[a-z]$/.test(k.sequence)) {
          const next =
            orderedKinds.find((x, j) => j > i && x.startsWith(k.sequence!)) ??
            orderedKinds.find((x) => x.startsWith(k.sequence!));
          if (next) setKind(next);
          return true;
        }
        return false;
      }
      if (field === "qty") {
        if (k.name === "right" || k.sequence === "+") return used(setQty(qty + 1));
        if (k.name === "left" || k.sequence === "-") return used(setQty(Math.max(1, qty - 1)));
        if (k.name === "backspace") return used(setQty(Math.max(1, Math.floor(qty / 10))));
        const d = Number(k.sequence);
        if (k.sequence && /^\d$/.test(k.sequence))
          return used(setQty(Math.min(9999, qty === 1 && d > 0 ? d : qty * 10 + d)));
        return Boolean(k.sequence && /^[a-z]$/i.test(k.sequence));
      }
      return false;
    },
    {
      paste: (text) => {
        const t = text.trim();
        if (isUrl(t)) return used(readLink(t));
        if (field === "spot") spot.insert(t);
        else name.insert(t);
        return true;
      },
    },
  );

  // ---------------------------------------------------------------- layout
  const twoCols = size !== "tiny" && size !== "narrow";
  const leftW = twoCols ? Math.floor(w * 0.56) : w;
  const rightW = twoCols ? w - leftW - 1 : w;
  const iw = leftW - 4;
  const lab = 10;
  const fw = iw - lab;
  const labelSeg = (f: Field, text: string): Seg => ({
    t: fit(text, lab),
    fg: field === f ? th.fg : th.dim,
    b: field === f,
  });
  const chip = (text: string, on: boolean): Seg[] => [
    on ? { t: ` ${text} `, bg: th.selBg, fg: th.selFg } : { t: `[${text}]`, fg: th.fg },
    { t: " " },
  ];

  const kindChips: Seg[] = [];
  let kw = 0;
  const shown = orderedKinds.includes(kind) ? orderedKinds : [kind, ...orderedKinds];
  for (const x of shown) {
    if (kw + width(x) + 3 > fw - 8 && x !== kind) continue;
    kindChips.push(...chip(x, x === kind));
    kw += width(x) + 3;
  }

  const left = (
    <Pane title="Add a thing" focused width={leftW} height={twoCols ? h : Math.min(h, 16)}>
      <L w={iw} segs={[{ t: "What is it? A name is enough — or paste a product link.", fg: th.dim }]} />
      <box
        border
        borderStyle="rounded"
        borderColor={field === "name" ? th.focus : th.line}
        height={3}
        paddingLeft={1}
      >
        <LineView line={name} w={iw - 4} active={field === "name"} placeholder="ESP32-CAM" />
      </box>
      {link && (
        <L
          w={iw}
          segs={[
            { t: "↗ ", fg: th.link },
            {
              t: cut(link.page?.title ? `${link.page.siteName ?? ""} ${link.url}` : link.url, iw - 3),
              fg: th.link,
              href: link.url,
            },
          ]}
        />
      )}
      {dups.length > 0 ? (
        <>
          <L
            w={iw}
            segs={[
              { t: "▲ ", fg: th.warn },
              { t: `You already have ${dups.length} ${dups[0]!.name}  ` },
              {
                t: dups
                  .slice(0, 3)
                  .map((d) => `${d.id} · ${whereText(d, 30)}`)
                  .join("  "),
                fg: th.dim,
              },
            ]}
          />
          <L
            w={iw}
            segs={[
              { t: "  " },
              kc(th, "⌃Y"),
              { t: ` one more on ${dups[0]!.id}  `, fg: th.dim },
              kc(th, "⌃O"),
              { t: " open it  ", fg: th.dim },
              { t: "or ⏎ to add a new one", fg: th.dim },
            ]}
          />
        </>
      ) : (
        <L w={iw} segs={[]} />
      )}
      <L
        w={iw}
        segs={[
          labelSeg("where", "Where"),
          wherePath ? foldPath(wherePath.split(SEP), fw - 14) : { t: "▲ not placed yet", fg: th.warn },
          { t: placeId === undefined && where ? "  · last used" : "", fg: th.dim },
        ]}
      />
      <L
        w={iw}
        segs={[
          { t: " ".repeat(lab) },
          ...recentPlaces.flatMap((id, i) =>
            chip(`${i + 1} ${cut(byId.get(id)?.name ?? id, 18)}`, id === where),
          ),
          { t: "⌃P pick", fg: th.dim },
        ]}
      />
      <L w={iw} segs={[labelSeg("spot", "Spot")]} />
      <box marginTop={-1} marginLeft={lab}>
        <LineView
          line={spot}
          w={fw}
          active={field === "spot"}
          placeholder={where ? 'optional · e.g. "shelf 3", "front left"' : "optional (pick a place first)"}
        />
      </box>
      <L w={iw} segs={[labelSeg("kind", "Kind"), ...kindChips]} />
      <L
        w={iw}
        segs={[labelSeg("qty", "Quantity"), kc(th, "−"), { t: `  ${qty}  `, b: true }, kc(th, "+")]}
      />
      <box flexGrow={1} />
      <L
        w={iw}
        segs={[
          { t: saving ? " Saving… " : " ⏎ Save ", bg: th.main, fg: th.onMain, b: true },
          { t: "   nothing is required but a name", fg: th.dim },
        ]}
      />
    </Pane>
  );

  const stepLine = stepText(suggest.step);
  const right = (
    <box flexDirection="column" width={rightW} height={twoCols ? h : Math.max(0, h - 16)} gap={0}>
      <Pane title="Just saved" height={Math.min(14, Math.max(6, 7 + guesses.length))}>
        {lastThing ? (
          <>
            <L
              w={rightW - 4}
              segs={[
                { t: lastThing.name, b: true },
                { t: `  ${lastThing.id} · ${whereText(lastThing, rightW - 20)}`, fg: th.dim },
              ]}
            />
            <L
              w={rightW - 4}
              segs={[
                {
                  t: stepLine || (ai.preferred ? `s suggest · ${ai.preferred.label}` : "no AI set up"),
                  fg: suggest.step.s === "error" ? th.bad : th.ai,
                },
              ]}
            />
            {guesses
              .filter((k) => k !== "name")
              .map((k) => (
                <L
                  key={k}
                  w={rightW - 4}
                  segs={[
                    { t: fit(k, 14), fg: th.dim },
                    {
                      t: `✦ ${String(lastThing.data[k] ?? (k === "kind" ? lastThing.kind : ""))}`,
                      fg: th.ai,
                    },
                  ]}
                />
              ))}
            {aiTags.length > 0 && (
              <L
                w={rightW - 4}
                segs={[
                  { t: fit("Tags", 14), fg: th.dim },
                  { t: `✦ ${plural(aiTags.length, "tag")} suggested, folded  ⌃O review`, fg: th.ai },
                ]}
              />
            )}
            {guesses.length > 0 && (
              <L
                w={rightW - 4}
                segs={[
                  kcAi(th, "Y"),
                  { t: ` All right (${guesses.length + aiTags.length})   `, fg: th.ai },
                  kc(th, "N"),
                  { t: " all wrong", fg: th.dim },
                ]}
              />
            )}
          </>
        ) : (
          <L
            w={rightW - 4}
            segs={[
              { t: "Nothing yet. Things you add show up here, with what AI makes of them.", fg: th.dim },
            ]}
          />
        )}
      </Pane>
      <Pane title={`This session · ${session.length} added`} flexGrow={1}>
        {session.slice(0, 20).map((s) => {
          const n = s.thing.id === lastThing?.id ? guesses.length : 0;
          return (
            <L
              key={s.thing.id}
              w={rightW - 4}
              segs={[
                { t: fit(s.thing.id, 8), fg: th.dim },
                s.thing.name,
                n ? { t: ` ✦${n}`, fg: th.ai } : null,
              ]}
              onClick={() => app.go({ s: "thing", id: s.thing.id })}
            />
          );
        })}
        <box flexGrow={1} />
        {where && (
          <L
            w={rightW - 4}
            segs={[{ t: `Next add keeps the place: ${cut(wherePath ?? "", rightW - 30)}`, fg: th.dim }]}
          />
        )}
      </Pane>
    </box>
  );

  return (
    <box flexDirection={twoCols ? "row" : "column"} width={w} height={h} gap={twoCols ? 1 : 0}>
      {left}
      {(twoCols || h > 22) && right}
    </box>
  );
}
