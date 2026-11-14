import { useEffect } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, type Overview } from "./lib/api.ts";

export function Layout() {
  const navigate = useNavigate();
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
        if (box) box.focus();
        else navigate("/");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Burrow home">
          <svg
            width="28"
            height="28"
            viewBox="0 0 28 28"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M3 24 C3 12, 25 12, 25 24 Z" />
            <path d="M10 24 C10 18, 18 18, 18 24" />
          </svg>
          Burrow
        </Link>
        <nav className="nav" aria-label="Views">
          <NavLink to="/" end>
            Find
          </NavLink>
          <NavLink to="/papers">
            Papers
            {data?.papers.inbox ? <span className="count">{data.papers.inbox}</span> : null}
          </NavLink>
          <NavLink to="/later">Needs details</NavLink>
        </nav>
        <Link to="/add" className="btn">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add a thing
        </Link>
      </header>
      <Outlet />
    </div>
  );
}
