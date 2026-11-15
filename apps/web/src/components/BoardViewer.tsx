import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { AssetView } from "../lib/api.ts";

type Mode = "top" | "bottom" | "xray";
type Pt = { x: number; y: number };

/** The newest photo of one side (data.view = top | bottom, from the PCB rig; D-018). */
function side(assets: AssetView[], view: string) {
  return assets.filter((a) => a.data.view === view && a.width && a.height).at(-1);
}

/**
 * Both sides of a board at true scale: flip between them, X-ray the mirrored bottom
 * over the top, and measure in millimetres (the rig shoots at a fixed px/mm).
 */
export function BoardViewer({ assets }: { assets: AssetView[] }) {
  const top = side(assets, "top");
  const bottom = side(assets, "bottom");
  const [mode, setMode] = useState<Mode>(top ? "top" : "bottom");
  const [mix, setMix] = useState(50);
  const [turn, setTurn] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [pts, setPts] = useState<Pt[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(800);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (!top && !bottom) return null;
  const shown = mode === "xray" ? [top!, bottom!] : [mode === "top" ? (top ?? bottom)! : (bottom ?? top)!];
  const pxPerMm = Number(shown[0]!.data.pxPerMm ?? 20);
  // Both sides share the rig's scale, so one stage in image pixels fits either.
  const W = Math.max(...shown.map((a) => a.width!));
  const H = Math.max(...shown.map((a) => a.height!));
  const s = Math.min(boxW / W, 400 / H, 1.5);
  const place = (a: AssetView) => ({
    left: ((W - a.width!) / 2) * s,
    top: ((H - a.height!) / 2) * s,
    width: a.width! * s,
    height: a.height! * s,
  });
  const at = (e: MouseEvent<HTMLDivElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };
  const mm = pts.length === 2 ? Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y) / pxPerMm : null;
  const size = (a?: AssetView) =>
    a?.data.widthMm && a.data.heightMm ? `${String(a.data.widthMm)} × ${String(a.data.heightMm)} mm` : null;

  return (
    <section className="panel stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="eyebrow">Both sides</h2>
        <div className="row">
          <div className="seg-group" role="group" aria-label="Side">
            {(["top", "bottom", "xray"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className="chip"
                aria-pressed={mode === m}
                disabled={
                  (m === "top" && !top) || (m === "bottom" && !bottom) || (m === "xray" && !(top && bottom))
                }
                onClick={() => setMode(m)}
              >
                {m === "xray" ? "X-ray" : m === "top" ? "Top" : "Bottom"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="chip"
            aria-pressed={measuring}
            onClick={() => {
              setMeasuring((v) => !v);
              setPts([]);
            }}
          >
            📏 Measure
          </button>
        </div>
      </div>

      <div ref={box} style={{ width: "100%" }}>
        <div
          className={`board-stage${measuring ? " measuring" : ""}`}
          style={{ width: W * s, height: H * s }}
          onClick={(e) => {
            if (!measuring) return;
            const p = at(e);
            setPts((old) => (old.length >= 2 ? [p] : [...old, p]));
          }}
        >
          {shown.map((a, i) => (
            <img
              key={a.id}
              src={a.fileUrl}
              alt={`${String(a.data.view)} side`}
              draggable={false}
              style={{
                ...place(a),
                opacity: mode === "xray" && i === 1 ? mix / 100 : 1,
                transform: mode === "xray" && i === 1 && turn ? "rotate(180deg)" : undefined,
              }}
            />
          ))}
          {pts.length > 0 && (
            <svg viewBox={`0 0 ${W} ${H}`} className="board-measure" aria-hidden="true">
              {pts.length === 2 && (
                <line x1={pts[0]!.x} y1={pts[0]!.y} x2={pts[1]!.x} y2={pts[1]!.y} strokeWidth={3 / s} />
              )}
              {pts.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={6 / s} />
              ))}
            </svg>
          )}
        </div>
      </div>

      <div className="row small muted" style={{ justifyContent: "space-between" }}>
        <span>
          {measuring
            ? mm !== null
              ? `${mm.toFixed(mm < 10 ? 2 : 1)} mm`
              : pts.length
                ? "Click the second point"
                : "Click two points to measure"
            : [size(top ?? bottom), `${pxPerMm} px/mm`].filter(Boolean).join(" · ")}
        </span>
        {mode === "xray" && (
          <span className="row" style={{ gap: 8 }}>
            <label className="row" style={{ gap: 6 }}>
              Top
              <input
                type="range"
                min={0}
                max={100}
                value={mix}
                onChange={(e) => setMix(Number(e.target.value))}
                aria-label="Bottom side opacity"
              />
              Bottom
            </label>
            <label className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={turn} onChange={(e) => setTurn(e.target.checked)} />
              turn bottom 180°
            </label>
          </span>
        )}
        <span className="row" style={{ gap: 8 }}>
          {shown.map((a) =>
            a.originalUrl ? (
              <a key={a.id} href={a.originalUrl} target="_blank" rel="noreferrer">
                {String(a.data.view)} original
              </a>
            ) : null,
          )}
        </span>
      </div>
    </section>
  );
}
