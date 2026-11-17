import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, type Overview } from "./lib/api.ts";
import { Icon, Mark, type IconName } from "./ui/Icon.tsx";
import { useMe } from "./lib/auth.ts";

/** The places you go, in order. Workshop holds the admin pages (D-027). */
const NAV: { to: string; label: string; end?: boolean; count?: (o: Overview) => number | null }[] = [
  { to: "/", label: "Find", end: true },
  { to: "/places", label: "Places" },
  { to: "/papers", label: "Papers", count: (o) => o.papers.inbox },
  { to: "/tidy", label: "Tidy up" },
  { to: "/workshop", label: "Workshop" },
];

export const WORKSHOP: { group: string; items: { to: string; label: string; icon: IconName }[] }[] = [
  {
    group: "Shape",
    items: [
      { to: "/workshop/kinds", label: "Kinds & fields", icon: "kinds" },
      { to: "/workshop/tags", label: "Tags", icon: "tag" },
    ],
  },
  {
    group: "Under the hood",
    items: [
      { to: "/workshop/db", label: "Database", icon: "db" },
      { to: "/workshop/api", label: "API & tokens", icon: "plug" },
      { to: "/workshop/ai", label: "AI log", icon: "sparkle" },
      { to: "/terminal", label: "Terminal", icon: "terminal" },
      { to: "/workshop/system", label: "Design system", icon: "swatch" },
    ],
  },
];

export function Layout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data } = useQuery({
    queryKey: ["overview"],
    queryFn: () => get<Overview>("/overview"),
    refetchInterval: 60_000,
  });

  // Ctrl/Cmd+K anywhere: jump to search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const box = document.querySelector<HTMLInputElement>("input[data-search]");
        if (box && box.offsetParent) box.focus();
        else navigate("/");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Burrow, home">
          <Mark />
          Burrow
        </Link>
        {pathname !== "/" && <TopSearch />}
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => {
            const c = data && n.count ? n.count(data) : null;
            return (
              <NavLink key={n.to} to={n.to} end={n.end}>
                {n.label}
                {c ? <span className="count">{c}</span> : null}
              </NavLink>
            );
          })}
        </nav>
        <NavLink to="/add" className={({ isActive }) => `btn${isActive ? " active-add" : ""}`}>
          <Icon name="plus" size={16} stroke={2.5} />
          Add a thing
        </NavLink>
        <AccountLink />
      </header>
      <Outlet />
      <TabBar papers={data?.papers.inbox ?? null} />
    </div>
  );
}

/** Who's signed in: their initial, to the account page (D-032). */
function AccountLink() {
  const me = useMe();
  if (!me) return null;
  return (
    <NavLink to="/account" className="avatar" aria-label={`Your account: ${me.name}`} title={me.name}>
      {[...me.name.trim()][0]?.toUpperCase() ?? "?"}
    </NavLink>
  );
}

/** The small search in the top bar, on every page but Find (which has the big one). */
function TopSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  return (
    <form
      className="topsearch"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) navigate(`/?q=${encodeURIComponent(q.trim())}`);
        setQ("");
      }}
    >
      <Icon name="search" size={16} />
      <label className="sr-only" htmlFor="topsearch">
        Find
      </label>
      <input
        id="topsearch"
        data-search
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find a thing, a place, B-0042…"
        autoComplete="off"
      />
      <span className="kbd">Ctrl K</span>
    </form>
  );
}

/** Phones: Find, Places, the orange Add, Tidy, More (a sheet with the rest). */
function TabBar({ papers }: { papers: number | null }) {
  const { pathname } = useLocation();
  // Open for one page only: following a link in the sheet closes it.
  const [moreAt, setMoreAt] = useState<string | null>(null);
  const more = moreAt === pathname;
  const setMore = (open: boolean | ((o: boolean) => boolean)) =>
    setMoreAt((typeof open === "function" ? open(more) : open) ? pathname : null);
  const inMore =
    pathname.startsWith("/papers") || pathname.startsWith("/workshop") || pathname.startsWith("/account");
  return (
    <>
      <nav className="tabbar" aria-label="Main">
        <NavLink to="/" end>
          <Icon name="search" size={22} stroke={2.2} />
          Find
        </NavLink>
        <NavLink to="/places">
          <Icon name="pin" size={22} />
          Places
        </NavLink>
        <NavLink to="/add" className="tab-add" aria-label="Add a thing">
          <Icon name="plus" size={26} stroke={2.6} />
        </NavLink>
        <NavLink to="/tidy">
          <Icon name="tidy" size={22} />
          Tidy
        </NavLink>
        <button
          type="button"
          className={inMore || more ? "active" : ""}
          aria-expanded={more}
          onClick={() => setMore((m) => !m)}
        >
          <Icon name="more" size={22} stroke={3} />
          More
          {papers ? <span className="count">{papers}</span> : null}
        </button>
      </nav>
      {more && (
        <>
          <div className="sheet-backdrop" onClick={() => setMore(false)} />
          <div className="sheet" role="dialog" aria-label="More">
            <span className="grabber" />
            <AccountSheetLink />
            <NavLink to="/papers">
              <Icon name="paper" size={20} />
              <span className="grow">Papers</span>
              {papers ? (
                <span className="count" style={{ background: "var(--sunk)" }}>
                  {papers}
                </span>
              ) : null}
            </NavLink>
            {WORKSHOP.map((g) => (
              <div key={g.group} className="stack" style={{ gap: 2 }}>
                <div className="eyebrow">{g.group}</div>
                {g.items.map((i) => (
                  <NavLink key={i.to} to={i.to}>
                    <Icon name={i.icon} size={20} />
                    {i.label}
                  </NavLink>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function AccountSheetLink() {
  const me = useMe();
  if (!me) return null;
  return (
    <NavLink to="/account">
      <Icon name="person" size={20} />
      <span className="grow">{me.name}</span>
      <span className="muted small">account</span>
    </NavLink>
  );
}

/** Workshop: schema, tags and what's under the hood, with its own side nav. */
export function Workshop() {
  return (
    <div className="workshop">
      <nav className="workshop-nav" aria-label="Workshop">
        {WORKSHOP.map((g) => (
          <div key={g.group} className="workshop-group">
            <div className="eyebrow">{g.group}</div>
            {g.items.map((i) => (
              <NavLink key={i.to} to={i.to}>
                <Icon name={i.icon} size={18} />
                {i.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="workshop-body">
        <Outlet />
      </div>
    </div>
  );
}

/** Old addresses keep working (bookmarks, links in docs). */
export function Moved({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}
