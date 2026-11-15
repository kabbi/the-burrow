import type { ThingView } from "../lib/api.ts";
import { Icon, type IconName } from "../ui/Icon.tsx";
import { PageHead, SecHead, Verdict } from "../ui/parts.tsx";
import { Nowhere, ThingRow } from "../ui/thing.tsx";

/**
 * The design system, drawn with the real parts (D-027, docs/design-system.md). When a part
 * changes, this page changes with it; nothing here talks to the server.
 */
export function System() {
  return (
    <main className="page">
      <PageHead
        title="Quiet when fine. Loud only when it matters."
        lede="Every screen is a lens over the same things. These parts are shared by all of them, desktop, phone and bot. Source: src/ui/ and docs/design-system.md."
      />

      <section className="sys-principles" aria-label="Principles">
        {PRINCIPLES.map(([t, d], i) => (
          <div key={t} className="panel tight stack" style={{ gap: 6 }}>
            <span className="idtext">{String(i + 1).padStart(2, "0")}</span>
            <b>{t}</b>
            <span className="small" style={{ color: "var(--ink-2)" }}>
              {d}
            </span>
          </div>
        ))}
      </section>

      <div className="sys-two">
        <section className="panel stack">
          <SecHead title="Colour · one meaning each" />
          <div className="sys-swatches">
            {COLOURS.map(([v, name, use]) => (
              <div key={v} className="row" style={{ flexWrap: "nowrap" }}>
                <span className="sys-swatch" style={{ background: `var(${v})` }} />
                <span>
                  <b style={{ display: "block" }}>{name}</b>
                  <span className="idtext">
                    {v} · {use}
                  </span>
                </span>
              </div>
            ))}
          </div>
          <div className="row" style={{ borderTop: "1px solid var(--line-3)", paddingTop: 12 }}>
            {NEUTRALS.map(([v, name]) => (
              <span key={v} className="row small" style={{ gap: 6, color: "var(--ink-2)" }}>
                <span className="sys-swatch small" style={{ background: `var(${v})` }} />
                {name} <span className="idtext">{v}</span>
              </span>
            ))}
          </div>
        </section>

        <section className="panel stack">
          <SecHead title="Type" />
          <div className="sys-type">
            <span className="question">Where’s my…</span>
            <span className="small muted">Space Grotesk 700 · 48 · the page question</span>
            <h1 style={{ fontSize: 36 }}>Yamaha P-45</h1>
            <span className="small muted">Space Grotesk 700 · 36 · page and thing names</span>
            <span className="tname">Pinecil V2</span>
            <span className="small muted">Space Grotesk 600 · 18 · row names</span>
            <span>A digital piano, bought used.</span>
            <span className="small muted">Inter 400 · 15 · body</span>
            <span className="eyebrow">What Burrow knows</span>
            <span className="small muted">Inter 600 · 12 · caps label over sections</span>
            <span>
              <span className="idbadge">B-0214</span> <span className="mono">349.00 EUR</span>
            </span>
            <span className="small muted">JetBrains Mono · IDs, slugs, money, counts, keys</span>
          </div>
        </section>
      </div>

      <section className="panel stack">
        <SecHead title="Actions">
          <span className="small muted">One orange per screen · no confirm dialogs · no red buttons</span>
        </SecHead>
        <div className="row">
          <button type="button" className="btn main">
            <Icon name="plus" size={16} stroke={2.5} />
            Add a thing
          </button>
          <button type="button" className="btn">
            Move
          </button>
          <button type="button" className="btn quiet">
            It’s not here
          </button>
          <button type="button" className="btn ghost">
            Archive
          </button>
          <button type="button" className="btn small">
            Undo
          </button>
          <button type="button" className="btn quiet icon" aria-label="More">
            <Icon name="more" size={20} stroke={3} />
          </button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          <code>.btn.main</code> the thing you most likely came to do · <code>.btn</code> outlined in ink ·{" "}
          <code>.btn.quiet</code> outlined in line · <code>.btn.ghost</code> text. Deleting is archiving, and
          archiving is undoable.
        </p>
        <div className="row" style={{ borderTop: "1px solid var(--line-3)", paddingTop: 12 }}>
          <button type="button" className="btn ai">
            <Icon name="sparkle" size={16} />
            Suggest details · free
          </button>
          <button type="button" className="btn ai">
            Ask Claude · <span className="mono">$0.012</span>
          </button>
          <button type="button" className="btn ai solid small">
            All right
          </button>
          <Verdict what="example" onRight={() => {}} onWrong={() => {}} />
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Every AI button says which model and what it costs. Local runs on tap; paid shows the price on the
          button, so the tap is the consent.
        </p>
      </section>

      <div className="sys-two">
        <section className="panel stack">
          <SecHead title="Chips, tags, pills, counts" />
          <div className="row">
            <button type="button" className="chip" aria-pressed="true">
              Working Room
            </button>
            <button type="button" className="chip">
              usb <span className="n">7</span>
            </button>
            <button type="button" className="chip dashed">
              + tag
            </button>
            <button type="button" className="chip ai">
              + desk
            </button>
          </div>
          <div className="row">
            <span className="tag">furniture</span>
            <span className="pill bad">
              <Icon name="alert" size={14} stroke={2.2} />
              Missing · last in Cellar
            </span>
            <span className="pill ai">
              <Icon name="sparkle" size={14} />2 AI guesses to check
            </span>
            <span className="pill warn">Warranty ends in 3 weeks</span>
            <span className="pill ok">
              <Icon name="check" size={14} stroke={2.4} />
              Saved as B-0224
            </span>
            <span className="row small" style={{ gap: 6 }}>
              Papers{" "}
              <span className="count" style={{ background: "var(--sunk)" }}>
                4
              </span>
            </span>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Chip = you tap it (pressed is ink). Tag = a label. Pill = a status, only when something isn’t
            fine, always a word. Counts are neutral; green only answers something you just did.
          </p>
        </section>

        <section className="panel stack">
          <SecHead title="Where it is · one path format" />
          <span className="path chips">
            <span className="seg">Cooking Room</span>
            <span className="sep">›</span>
            <span className="seg">Drugs crate</span>
            <span className="spot">top shelf</span>
          </span>
          <span className="small muted">
            Thing page: every step a chip, the last one bold, the spot after a dot.
          </span>
          <span className="path">
            <span className="seg">Working Room</span>
            <span className="sep">›</span>
            <span className="sep">…</span>
            <span className="sep">›</span>
            <span className="seg">Kabbi’s Table</span>
          </span>
          <span className="small muted">In rows: the room, “…”, then the last step.</span>
          <div className="row">
            <Nowhere roams={false} big />
            <Nowhere roams big />
          </div>
          <span className="small muted">
            Two different nowheres (D-026): a gap to fill, and things that travel (laptop, phone, Steam Deck).
          </span>
        </section>
      </div>

      <section className="panel stack">
        <SecHead title="The thing row · the one card, in list form">
          <span className="small muted">Picture · name + ID · where · status only if not fine · actions</span>
        </SecHead>
        <div className="rows">
          {SAMPLES.map((t) => (
            <ThingRow key={t.id} thing={t} actions={false} />
          ))}
        </div>
      </section>

      <div className="sys-two">
        <section className="panel stack">
          <SecHead title="A fact and where it came from" />
          <div className="facts">
            <div className="fact">
              <span className="label">Bought on</span>
              <span className="value">2024-12-06</span>
              <span />
            </div>
            <div className="fact">
              <span className="label">Price</span>
              <span className="value mono">349.00 EUR</span>
              <span className="src">from ikea.com</span>
            </div>
            <div className="fact ai">
              <span className="label">Description</span>
              <span className="value">A digital piano with 88 weighted keys.</span>
              <Verdict what="description" onRight={() => {}} onWrong={() => {}} />
            </div>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            You = no label. Anyone else = grey label. Unchecked AI = violet with ✓ ✕; “All right” clears them
            all.
          </p>
        </section>
        <section className="panel stack">
          <SecHead title="Feedback" />
          <div className="toast" style={{ boxShadow: "none" }}>
            <span className="grow">Confirmed Maker, Model · removed Price</span>
            <button type="button">
              <Icon name="undo" size={14} stroke={2.2} />
              Undo
            </button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Bottom left (above the tab bar on phones), 10 s, quick repeats merge into one toast and one Undo.
            Everything stays undoable from history.
          </p>
          <SecHead title="Icons" />
          <div className="row" style={{ gap: 14 }}>
            {ICONS.map((n) => (
              <span key={n} title={n} style={{ color: "var(--ink-2)" }}>
                <Icon name={n} size={22} />
              </span>
            ))}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Interface icons are 24 px strokes (src/ui/Icon.tsx). Thing pictures use Material Design Icons
            (D-022).
          </p>
        </section>
      </div>
    </main>
  );
}

const PRINCIPLES: [string, string][] = [
  ["Fine is silent", "No status when nothing is wrong. A thing in its place shows its path, nothing else."],
  [
    "Words first, colour agrees",
    "A status is always a word with an icon. Colour backs it up, never carries it alone.",
  ],
  ["One orange per screen", "The thing you most likely came to do. Everything else is outlined or quiet."],
  ["Act, then Undo", "No confirm dialogs. Do it, show a 10 s toast, keep it in history forever."],
  [
    "Violet until a person agrees",
    "AI writes straight away, in violet, with Right and Wrong. Paid AI shows its price first.",
  ],
];

const COLOURS: [string, string, string][] = [
  ["--main", "Orange · do this", "one per screen"],
  ["--ink", "Ink · selected", "nav, chips, rows"],
  ["--ai", "Violet · AI, unchecked", "on --ai-tint"],
  ["--bad", "Red · wrong", "missing, failed"],
  ["--warn", "Amber · heads-up", "on --warn-tint"],
  ["--ok", "Green · done", "right after an action"],
];

const NEUTRALS: [string, string][] = [
  ["--bg", "Ground"],
  ["--panel", "Surface"],
  ["--sunk", "Sunken"],
  ["--line", "Line"],
  ["--muted", "Muted text"],
  ["--dash", "Dashed"],
];

const ICONS: IconName[] = [
  "search",
  "pin",
  "plus",
  "move",
  "bag",
  "sparkle",
  "check",
  "x",
  "undo",
  "more",
  "camera",
  "tidy",
  "alert",
  "link",
  "paper",
  "workshop",
  "tag",
  "kinds",
  "db",
  "plug",
  "box",
  "print",
  "history",
  "group",
];

function sample(over: Partial<ThingView> & Pick<ThingView, "id" | "name">): ThingView {
  return {
    seq: 0,
    kind: "thing",
    data: {},
    meta: {},
    parentId: null,
    position: null,
    roams: false,
    status: "ok",
    createdAt: "",
    updatedAt: "",
    archivedAt: null,
    path: [],
    refs: [],
    gaps: [],
    childCount: 0,
    tags: [],
    cover: null,
    ...over,
  };
}

const ROOM = { id: "B-0001", name: "Working Room", kind: "room" };
const SAMPLES: ThingView[] = [
  sample({
    id: "B-0207",
    name: "Pinecil V2",
    parentId: "B-0183",
    path: [ROOM, { id: "B-0183", name: "Kabbi’s Table", kind: "furniture" }],
  }),
  sample({
    id: "B-0188",
    name: "Meta Quest 2",
    status: "missing",
    parentId: "B-0180",
    path: [ROOM, { id: "B-0180", name: "IKEA Ivar (servers)", kind: "furniture" }],
  }),
  sample({
    id: "B-0221",
    name: "Petya’s Desk",
    parentId: ROOM.id,
    path: [ROOM],
    data: { description: "A green office desk.", maker: "IKEA" },
    meta: {
      description: { source: "ai", at: "" },
      maker: { source: "ai", at: "" },
    },
  }),
  sample({ id: "B-0006", name: "1.8″ TFT SPI 128×160 display", kind: "pcb", gaps: ["where"] }),
  sample({ id: "B-0206", name: "Steam Deck", kind: "electronics", roams: true }),
];
