import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

// The terminal mode of the web app (D-037): the same terminal app as `burrow` on the command
// line, drawn by ghostty-web (Ghostty's terminal engine as WASM). The server runs one copy per
// tab, signed in as you, over a WebSocket (apps/server/src/tui.ts).

type State = { s: "loading" } | { s: "open" } | { s: "ended"; why: string };

/** Keys a phone keyboard doesn't have. Ctrl is sticky: it applies to the next key. */
const KEYS: { label: string; aria?: string; send?: string; ctrl?: true }[] = [
  { label: "esc", send: "\x1b" },
  { label: "tab", send: "\t" },
  { label: "ctrl", ctrl: true },
  { label: "↑", aria: "Up", send: "\x1b[A" },
  { label: "↓", aria: "Down", send: "\x1b[B" },
  { label: "⏎", aria: "Enter", send: "\r" },
  { label: "⌃K", aria: "Commands", send: "\x0b" },
];

/** Ctrl + a letter → its control code (⌃K = 0x0b). */
const withCtrl = (d: string) =>
  d.length === 1 && /[a-z@[\\\]^_]/i.test(d) ? String.fromCharCode(d.toUpperCase().charCodeAt(0) & 0x1f) : d;

export function TerminalPage() {
  const box = useRef<HTMLDivElement>(null);
  const send = useRef<(d: string) => void>(() => {});
  const ctrlRef = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  const [state, setState] = useState<State>({ s: "loading" });
  const [run, setRun] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const { init, Terminal, FitAddon } = await import("ghostty-web");
      await init();
      if (disposed) return;
      const css = getComputedStyle(document.documentElement);
      const v = (name: string) => css.getPropertyValue(name).trim();
      const term = new Terminal({
        fontSize: window.innerWidth < 720 ? 12 : 14,
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        cursorBlink: false,
        scrollback: 0,
        theme: {
          background: v("--term-bg"),
          foreground: v("--term-fg"),
          cursor: v("--term-fg"),
          selectionBackground: v("--term-key-line"),
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${proto}://${location.host}/api/tui?cols=${term.cols}&rows=${term.rows}&theme=dark`,
      );
      ws.binaryType = "arraybuffer";
      ws.onopen = () => setState({ s: "open" });
      ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
      ws.onclose = (e) =>
        setState({
          s: "ended",
          why: e.code === 1006 ? "The connection dropped." : e.reason && e.reason !== "ended" ? e.reason : "",
        });
      send.current = (d) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const data = ctrlRef.current ? withCtrl(d) : d;
        if (ctrlRef.current) {
          ctrlRef.current = false;
          setCtrl(false);
        }
        ws.send(JSON.stringify({ t: "i", d: data }));
      };
      const onData = term.onData((d: string) => send.current(d));
      const onResize = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "r", cols, rows }));
      });
      const ro = new ResizeObserver(() => fit.fit());
      ro.observe(el);
      term.focus();
      cleanup = () => {
        ro.disconnect();
        onData.dispose();
        onResize.dispose();
        ws.close();
        term.dispose();
      };
    })().catch((e: Error) => setState({ s: "ended", why: e.message }));
    return () => {
      disposed = true;
      cleanup();
    };
  }, [run]);

  return (
    <div className="term-page">
      <header className="term-head">
        <span className="term-title">Burrow · terminal</span>
        <span className="term-state">
          {state.s === "loading" ? "Starting…" : state.s === "ended" ? "Ended" : ""}
        </span>
        <Link to="/">Open web app</Link>
      </header>
      <div className="term-screen" ref={box} />
      {state.s === "ended" && (
        <div className="term-ended" role="status">
          <p>{state.why || "The terminal ended."}</p>
          <button
            type="button"
            className="btn small"
            onClick={() => (setState({ s: "loading" }), setRun((n) => n + 1))}
          >
            Start again
          </button>
        </div>
      )}
      <div className="term-keys" aria-label="Keys">
        {KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            className="term-key"
            aria-label={k.aria ?? k.label}
            {...(k.ctrl ? { "aria-pressed": ctrl } : {})}
            // Keep the terminal focused (and the phone keyboard up).
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              if (k.ctrl) {
                ctrlRef.current = !ctrlRef.current;
                setCtrl(ctrlRef.current);
              } else if (k.send) send.current(k.send);
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
