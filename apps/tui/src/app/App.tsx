import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBlur, useFocus, useRenderer, useTerminalDimensions } from "@opentui/react";
import { get, post, type BurrowEvent, type EventRow, type Me } from "../api.ts";
import { cut, plural, width } from "../text.ts";
import { useOverview } from "./data.ts";
import { KeyRouter, type Key } from "./keys.tsx";
import { MovePicker, Palette, Prompt, type MoveTarget } from "./modals.tsx";
import { Screen } from "./screens/index.tsx";
import {
  Provide,
  ScreenCtx,
  ScreenStore,
  sizeOf,
  TABS,
  type App as AppApi,
  type Command,
  type Movable,
  type Route,
  type Written,
} from "./state.tsx";
import { useTheme } from "./theme.ts";
import { kc, L, type Seg } from "./ui.tsx";

const TOAST_MS = 10_000;
/** The time, for event handlers (render reads `now` state instead). */
const clock = () => Date.now();

interface Toast {
  text: string;
  kind: "ok" | "error" | "info";
  /** Events to revert, newest last. */
  seqs: number[];
  /** After an undo: the undo events, so ⌃R can redo. */
  redo?: number[];
  group?: string;
  until: number;
}

type Modal =
  | { m: "palette" }
  | { m: "move"; things: Movable[] }
  | { m: "pick"; title: string; onPick(t: MoveTarget): void }
  | { m: "prompt"; title: string; initial?: string; hint?: string; onSubmit(v: string): void };

export function App({
  me,
  url,
  webUrl,
  remote,
  quit,
}: {
  me: Me | null;
  url: string;
  webUrl: string;
  remote: boolean;
  quit: () => void;
}) {
  const { width: W, height: H } = useTerminalDimensions();
  const th = useTheme();
  const qc = useQueryClient();
  const renderer = useRenderer();
  const [stack, setStack] = useState<Route[]>([{ s: "find" }]);
  const route = stack.at(-1)!;
  const [toast, setToast] = useState<Toast | null>(null);
  const toastRef = useRef(toast);
  useLayoutEffect(() => {
    toastRef.current = toast;
  });
  const [now, setNow] = useState(clock);
  const [modal, setModal] = useState<Modal | null>(null);
  const screens = useMemo(() => new ScreenStore(), []);
  const [focused, setFocused] = useState(true);
  useFocus(() => setFocused(true));
  useBlur(() => setFocused(false));

  // The toast's countdown.
  useEffect(() => {
    if (!toast) return;
    const t = setInterval(() => {
      if (clock() > toast.until) setToast(null);
      else setNow(clock());
    }, 1000);
    return () => clearInterval(t);
  }, [toast]);

  // Live: other people's (and other tabs') changes show up. Paused while the terminal is hidden.
  const lastSeq = useRef<number | null>(null);
  useEffect(() => {
    if (!focused) return;
    const poll = async () => {
      const { events } = await get<{ events: EventRow[] }>("/events?limit=1").catch(() => ({ events: [] }));
      const seq = events[0]?.seq ?? null;
      if (lastSeq.current !== null && seq !== lastSeq.current) void qc.invalidateQueries();
      lastSeq.current = seq;
    };
    void poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, [focused, qc]);

  const show = (t: Omit<Toast, "until">) => {
    const at = clock();
    setNow(at);
    setToast({ ...t, until: at + TOAST_MS });
  };

  async function undo(seqs: number[], text: string) {
    const done: number[] = [];
    try {
      for (const s of seqs.toReversed())
        done.push((await post<{ event: BurrowEvent }>(`/events/${s}/undo`)).event.seq);
      await qc.invalidateQueries();
      show({ text: `Undone: ${text}`, kind: "info", seqs: [], redo: done });
    } catch (e) {
      show({ text: (e as Error).message, kind: "error", seqs: [] });
    }
  }

  async function undoLast() {
    const t = toastRef.current;
    if (t?.seqs.length && clock() < t.until) return undo(t.seqs, t.text);
    const { events } = await get<{ events: EventRow[] }>("/events?limit=100");
    const mine = events.find((e) => e.undoable && !e.undone && !e.undoOf && (!me || e.actor === me.username));
    if (!mine) return show({ text: "Nothing of yours to undo lately", kind: "info", seqs: [] });
    const label = `${mine.thing?.name ?? `#${mine.seq}`}`;
    return undo([mine.seq], label);
  }

  async function redo() {
    const t = toastRef.current;
    if (!t?.redo?.length) return show({ text: "Nothing to redo", kind: "info", seqs: [] });
    const seqs: number[] = [];
    for (const s of t.redo.toReversed())
      seqs.push((await post<{ event: BurrowEvent }>(`/events/${s}/undo`)).event.seq);
    await qc.invalidateQueries();
    show({ text: t.text.replace(/^Undone: /, "Redone: "), kind: "ok", seqs });
  }

  const area = { w: Math.max(0, W - 2), h: Math.max(0, H - 3), size: sizeOf(W) };

  const app: AppApi = {
    me,
    url,
    remote,
    route,
    area,
    go: (r) => setStack((s) => (r.s === "thing" ? [...s, r] : [r])),
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    async act(fn, text, opts = {}) {
      try {
        const r = await fn();
        await qc.invalidateQueries();
        const seqs = r.events?.map((e) => e.seq) ?? (r.event ? [r.event.seq] : []);
        const line = typeof text === "function" ? text(r) : text;
        const prev = toastRef.current;
        if (opts.group && prev?.group === opts.group && clock() < prev.until)
          show({ ...prev, text: `${prev.text}, ${line}`, seqs: [...prev.seqs, ...seqs] });
        else show({ text: line, kind: "ok", seqs, ...(opts.group ? { group: opts.group } : {}) });
        return r;
      } catch (e) {
        show({ text: (e as Error).message, kind: "error", seqs: [] });
        return undefined;
      }
    },
    toast: (text, kind = "info") => show({ text, kind, seqs: [] }),
    move: (things) => things.length && setModal({ m: "move", things }),
    moveTo: (things, to) => moveTo(things, to),
    pickPlace: (title, onPick) => setModal({ m: "pick", title, onPick }),
    prompt: (p) => setModal({ m: "prompt", ...p }),
    copy(text, what) {
      const ok = renderer.copyToClipboardOSC52(text);
      show({
        text: ok ? `Copied ${what ?? text}` : `${text}  (this terminal can't copy: select it)`,
        kind: "info",
        seqs: [],
      });
    },
    webUrl: (path) => `${webUrl}${path}`,
  };

  function moveTo(things: Movable[], t: MoveTarget) {
    const names = things.length === 1 ? things[0]!.name : plural(things.length, "thing");
    void app.act(
      async () => {
        const events: BurrowEvent[] = [];
        for (const x of things) {
          const r = await post<Written>(`/things/${x.id}/move`, {
            to: t.to,
            ...(t.position ? { position: t.position } : {}),
            ...(t.roams ? { roams: true } : {}),
          });
          if (r.event) events.push(r.event);
        }
        return { events };
      },
      `Moved ${names} → ${t.label}${t.position ? ` · ${t.position}` : ""}`,
    );
  }

  const globalCommands: Command[] = [
    ...TABS.map(([s, label], i): Command => ({
      section: "Go to",
      title: label,
      key: String(i + 1),
      run: () => app.go({ s }),
    })),
    { section: "Burrow", title: "Undo the last change", key: "u", run: () => void undoLast() },
    { section: "Burrow", title: "Redo", key: "⌃R", run: () => void redo() },
    {
      section: "Burrow",
      title: "Open in the web app",
      also: "browser link",
      run: () => app.copy(app.webUrl(route.s === "thing" ? `/t/${route.id}` : "/"), "the link"),
    },
    { section: "Burrow", title: remote ? "Leave the terminal" : "Quit", key: "q", run: quit },
  ];

  function onGlobal(k: Key) {
    if (k.ctrl && k.name === "c") return quit();
    if ((k.ctrl && k.name === "k") || k.sequence === "?") return setModal({ m: "palette" });
    if (k.ctrl && k.name === "r") return void redo();
    if (k.ctrl || k.meta) return;
    if (k.name === "escape") return app.back();
    if (k.sequence === "u") return void undoLast();
    if (k.sequence === "q") return route.s === "thing" ? app.back() : quit();
    const n = Number(k.sequence);
    if (n >= 1 && n <= TABS.length) app.go({ s: TABS[n - 1]![0] });
  }

  if (W < 40 || H < 14)
    return (
      <box width={W} height={H} backgroundColor={th.bg} alignItems="center" justifyContent="center">
        <text fg={th.dim}>Make the window a little bigger</text>
      </box>
    );

  const mw = Math.min(W - 4, 84);
  return (
    <Provide app={app}>
      <ScreenCtx.Provider value={screens}>
        <KeyRouter global={onGlobal}>
          <box width={W} height={H} flexDirection="column" backgroundColor={th.bg}>
            <TopBar
              route={route}
              w={W}
              me={me}
              go={app.go}
              back={app.back}
              palette={() => setModal({ m: "palette" })}
            />
            <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1} overflow="hidden">
              <Screen key={JSON.stringify(route)} route={route} />
            </box>
            <ToastLine toast={toast} w={W} now={now} />
            <HintsLine store={screens} w={W} />
            {modal?.m === "palette" && (
              <Palette
                w={mw}
                h={Math.min(H - 4, 24)}
                commands={[...screens.info.commands, ...globalCommands]}
                openThing={(id) => app.go({ s: "thing", id })}
                close={() => setModal(null)}
                {...(route.s === "thing" ? { context: `on ${route.id} · esc close` } : {})}
              />
            )}
            {modal?.m === "move" && (
              <MovePicker
                title={`Move ${modal.things.length === 1 ? modal.things[0]!.name : plural(modal.things.length, "thing")} to…`}
                w={mw}
                h={Math.min(H - 4, 22)}
                exclude={new Set(modal.things.map((t) => t.id))}
                onPick={(t) => moveTo(modal.things, t)}
                close={() => setModal(null)}
              />
            )}
            {modal?.m === "pick" && (
              <MovePicker
                title={modal.title}
                w={mw}
                h={Math.min(H - 4, 22)}
                exclude={new Set()}
                onPick={modal.onPick}
                close={() => setModal(null)}
              />
            )}
            {modal?.m === "prompt" && (
              <Prompt
                title={modal.title}
                w={Math.min(W - 4, 64)}
                onSubmit={modal.onSubmit}
                close={() => setModal(null)}
                {...(modal.initial !== undefined ? { initial: modal.initial } : {})}
                {...(modal.hint !== undefined ? { hint: modal.hint } : {})}
              />
            )}
          </box>
        </KeyRouter>
      </ScreenCtx.Provider>
    </Provide>
  );
}

/** The top row. Tabs (and the back link, and ⌃K on phones) are clickable. */
function TopBar({
  route,
  w,
  me,
  go,
  back,
  palette,
}: {
  route: Route;
  w: number;
  me: Me | null;
  go: (r: Route) => void;
  back: () => void;
  palette: () => void;
}) {
  const th = useTheme();
  const { data: ov } = useOverview();
  const size = sizeOf(w);
  const parts: { segs: Seg[]; onClick?: () => void }[] = [
    { segs: [{ t: " ▚ burrow  ", b: true }], onClick: () => go({ s: "find" }) },
  ];
  if (route.s === "thing") {
    parts.push({ segs: [{ t: "Find › ", fg: th.dim }], onClick: back }, { segs: [{ t: route.id, b: true }] });
  } else if (size === "tiny") {
    const i = TABS.findIndex(([s]) => s === route.s);
    parts.push({
      segs: [{ t: ` ${TABS[i]![1]} ▾ `, bg: th.selBg, fg: th.selFg, b: true }],
      onClick: palette,
    });
  } else {
    TABS.forEach(([s, label], i) => {
      const on = s === route.s;
      const text = size === "narrow" && !on ? ` ${i + 1} ` : ` ${i + 1} ${label} `;
      const segs: Seg[] = [on ? { t: text, bg: th.selBg, fg: th.selFg, b: true } : { t: text }];
      if (s === "needs" && ov?.needsDetails && size !== "narrow")
        segs.push({ t: `${ov.needsDetails} `, fg: th.warn });
      parts.push({ segs, onClick: () => go({ s }) }, { segs: [{ t: " " }] });
    });
  }
  const right: { segs: Seg[]; onClick?: () => void } =
    size === "tiny"
      ? { segs: [kc(th, "⌃K"), { t: " " }], onClick: palette }
      : {
          segs: [
            ...(ov && size === "wide"
              ? [
                  {
                    t: `${plural(ov.stats.things, "thing")} · ${plural(ov.stats.places, "place")} · ${plural(ov.stats.tags, "tag")}   `,
                    fg: th.dim,
                  },
                ]
              : []),
            { t: "● ", fg: th.ok },
            { t: me ? me.username : "signed in", fg: th.dim },
            { t: " " },
          ],
        };
  return (
    <box flexDirection="row" width={w} height={1}>
      {parts.map((p, i) => (
        <L key={i} segs={p.segs} {...(p.onClick ? { onClick: p.onClick } : {})} />
      ))}
      <box flexGrow={1} />
      <L segs={right.segs} {...(right.onClick ? { onClick: right.onClick } : {})} />
    </box>
  );
}

function ToastLine({ toast, w, now }: { toast: Toast | null; w: number; now: number }) {
  const th = useTheme();
  if (!toast) return <L w={w} segs={[]} />;
  const left = Math.max(0, Math.ceil((toast.until - now) / 1000));
  const glyph =
    toast.kind === "error"
      ? { t: " ✗ ", fg: th.bad }
      : toast.kind === "ok"
        ? { t: " ✓ ", fg: th.ok }
        : { t: " · ", fg: th.dim };
  const right: Seg[] = toast.seqs.length
    ? [
        kc(th, "u"),
        { t: ` undo${toast.seqs.length > 1 ? ` ${toast.seqs.length}` : ""} · ${left}s `, fg: th.dim },
      ]
    : toast.redo?.length
      ? [kc(th, "⌃R"), { t: ` redo · ${left}s `, fg: th.dim }]
      : [];
  const rw = right.reduce((n, s) => n + width(s.t), 0);
  return (
    <L
      w={w}
      bg={th.bar}
      segs={[
        glyph,
        { t: cut(toast.text, w - rw - 4), fg: toast.kind === "error" ? th.bad : th.fg, bg: th.bar },
        { t: " ".repeat(Math.max(0, w - rw - 3 - width(cut(toast.text, w - rw - 4)))), bg: th.bar },
        ...right,
      ]}
    />
  );
}

function HintsLine({ store, w }: { store: ScreenStore; w: number }) {
  const th = useTheme();
  const hints = useSyncExternalStore(store.subscribe, store.hints);
  const all: [string, string][] = [...hints, ["u", "undo"], ["⌃K", "commands"], ["?", "help"]];
  const segs: Seg[] = [{ t: " " }];
  let used = 1;
  for (const [k, label] of all) {
    const n = 1 + width(k) + width(label) + 3;
    if (used + n > w) break;
    // No background on the last row: some terminals (rex) stretch its colours into the window's
    // bottom padding. The keys are bold instead of keycaps here.
    segs.push({ t: ` ${k}`, b: true }, { t: ` ${label}  `, fg: th.dim });
    used += n;
  }
  return <L w={w} segs={segs} />;
}
