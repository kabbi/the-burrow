import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, patch, post, upload, type DailyPick } from "../lib/api.ts";
import { useRefresh, useUndo } from "../lib/hooks.ts";
import { useToast } from "../lib/toast.tsx";
import { Icon } from "../ui/Icon.tsx";
import { SecHead } from "../ui/parts.tsx";
import { Thumb, useNotHere } from "../ui/thing.tsx";

/** The viewer's local date, so the pick changes at their midnight. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const INPUT: Record<string, string> = { date: "date", number: "number", money: "number", url: "url" };

/**
 * Thing of the day (D-028): one small, useful nudge a day. "Still there?", "take a photo of your
 * own", or "fill in the one field it's missing". Up to three per day; "Another one" moves on.
 */
export function ThingOfTheDay() {
  const day = today();
  const { data } = useQuery({
    queryKey: ["today", day],
    queryFn: () => get<{ picks: DailyPick[] }>(`/today?day=${day}`),
    staleTime: 10 * 60_000,
  });
  const [i, setI] = useState(0);
  const picks = data?.picks ?? [];
  if (!picks.length) return null;
  const pick = picks[i % picks.length]!;
  return (
    <section className="panel tight stack tod" aria-label="Thing of the day" style={{ gap: 12 }}>
      <SecHead title="Thing of the day">
        <span className="small muted">
          {new Date(`${day}T12:00`).toLocaleDateString(undefined, {
            weekday: "short",
            day: "numeric",
            month: "short",
          })}
          {picks.length > 1 ? ` · ${(i % picks.length) + 1} of ${picks.length}` : ""}
        </span>
      </SecHead>
      <Pick key={pick.thing.id} pick={pick} onNext={picks.length > 1 ? () => setI((x) => x + 1) : null} />
    </section>
  );
}

function Pick({ pick, onNext }: { pick: DailyPick; onNext: (() => void) | null }) {
  const t = pick.thing;
  const refresh = useRefresh();
  const toast = useToast();
  const undo = useUndo();
  const { notHere } = useNotHere(t);
  const [done, setDone] = useState<{ text: string; seq?: number } | null>(null);
  const [typing, setTyping] = useState(false);
  const [value, setValue] = useState("");
  const place = t.path.at(-1)?.name ?? "its place";

  const run = async (fn: () => Promise<{ event?: { seq: number } }>, text: string) => {
    try {
      const r = await fn();
      setDone({ text, ...(r.event ? { seq: r.event.seq } : {}) });
      await refresh();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };

  const why =
    pick.why === "check"
      ? `In ${place}, and nobody has looked since ${new Date(pick.lastSeen ?? t.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}. Still there?`
      : pick.why === "photo"
        ? t.cover?.role === "product"
          ? "Only a shop picture so far. A photo of your own helps the bot recognise it."
          : t.cover
            ? "Only an icon so far. A photo of your own helps you, and the bot, recognise it."
            : "No picture yet. A photo of your own helps you, and the bot, recognise it."
        : `No ${pick.field!.label.toLowerCase()} yet. Add it while you think of it?`;

  return (
    <>
      <Link to={`/t/${t.id}`} className="tod-thing">
        <Thumb thing={t} size="tod" />
        <span className="stack" style={{ gap: 2, minWidth: 0 }}>
          <span className="tname" style={{ fontSize: 21, fontWeight: 700 }}>
            {t.name}
          </span>
          <span className="small" style={{ color: "var(--ink-2)" }}>
            {t.path.length
              ? t.path.map((p) => p.name).join(" › ")
              : t.roams
                ? "No fixed place"
                : "Not placed yet"}
          </span>
          <span className="idtext">{t.id}</span>
        </span>
      </Link>
      <div className="callout small" style={{ background: "var(--bg)", padding: "8px 10px" }}>
        {why}
      </div>
      {done ? (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="pill ok">
            <Icon name="check" size={14} stroke={2.4} />
            {done.text}
          </span>
          {done.seq && (
            <button
              type="button"
              className="linkbtn quiet small"
              onClick={async () => {
                await undo.mutateAsync(done.seq!);
                setDone(null);
              }}
            >
              Undo
            </button>
          )}
        </div>
      ) : typing && pick.field ? (
        <form
          className="row"
          style={{ flexWrap: "nowrap" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            const f = pick.field!;
            const v = INPUT[f.type] === "number" ? Number(value) : value.trim();
            void run(() => patch(`/things/${t.id}`, { data: { [f.key]: v } }), `${f.label} saved`);
          }}
        >
          <input
            className="input"
            autoFocus
            type={INPUT[pick.field.type] ?? "text"}
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={pick.field.label}
          />
          <button type="submit" className="btn small" disabled={!value.trim()}>
            Save
          </button>
        </form>
      ) : (
        <div className="row" style={{ gap: 6 }}>
          {pick.why === "check" && (
            <button
              type="button"
              className="btn small"
              style={{ borderColor: "var(--ink)" }}
              onClick={() =>
                void run(
                  () => post(`/things/${t.id}/confirm`, { fields: ["parent"] }),
                  `Seen today · ${place} is trusted`,
                )
              }
            >
              Yes, still there
            </button>
          )}
          {pick.why === "photo" && (
            <label className="btn small" style={{ borderColor: "var(--ink)", cursor: "pointer" }}>
              <Icon name="camera" size={16} />
              Take a photo
              <input
                className="sr-only"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file)
                    void run(
                      () => upload(`/things/${t.id}/assets`, file, { role: "photo", filename: file.name }),
                      "Photo added",
                    );
                }}
              />
            </label>
          )}
          {pick.why === "field" && (
            <button
              type="button"
              className="btn small"
              style={{ borderColor: "var(--ink)" }}
              onClick={() => setTyping(true)}
            >
              Add {pick.field!.label.toLowerCase()}
            </button>
          )}
          {pick.why === "check" && (
            <button type="button" className="btn small" onClick={() => void notHere()}>
              It’s not here
            </button>
          )}
          {onNext && (
            <button type="button" className="linkbtn quiet small" style={{ marginLeft: 4 }} onClick={onNext}>
              Another one
            </button>
          )}
        </div>
      )}
    </>
  );
}
