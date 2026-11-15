import { useEffect, useRef } from "react";

/**
 * The "Send to Burrow" bookmarklet (D-024). Some shops answer the server's /preview with an
 * anti-bot wall (DataDome, Cloudflare, …), but they let your own browser through. On the shop
 * page, the bookmarklet form-POSTs the page head (title, meta tags, canonical link, JSON-LD) to
 * /api/capture in a new tab. The server keeps what it read for /preview and opens Add.
 */
export function bookmarklet(origin: string): string {
  const code = `(()=>{const f=document.createElement('form');f.method='POST';f.action=${JSON.stringify(
    `${origin}/api/capture`,
  )};f.target='_blank';f.acceptCharset='utf-8';f.style.display='none';const a=(n,v)=>{const i=document.createElement('input');i.type='hidden';i.name=n;i.value=v;f.append(i)};a('url',location.href);a('html',[...document.querySelectorAll('title,meta,link[rel=canonical],script[type="application/ld+json"]')].map(e=>e.outerHTML).join('\\n'));document.body.append(f);f.submit();f.remove()})()`;
  return `javascript:${encodeURI(code)}`;
}

/** A draggable bookmarklet link. React refuses javascript: hrefs, so it's set on the element. */
export function SendToBurrow() {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    ref.current?.setAttribute("href", bookmarklet(location.origin));
  }, []);
  return (
    <a
      ref={ref}
      className="btn small"
      title="Drag me to your bookmarks bar"
      onClick={(e) => e.preventDefault()}
    >
      ↗ Send to Burrow
    </a>
  );
}

/** What to say when the server couldn't read a page; offers the bookmarklet when a shop blocks bots. */
export function BlockedHint({ onRetry }: { onRetry: () => void }) {
  return (
    <span className="small">
      This shop blocks automated reading, but your browser gets through. Drag <SendToBurrow /> to your
      bookmarks bar, then click it on the shop page. It opens Add with what it read; or come back here and{" "}
      <button type="button" className="btn ghost small" onClick={onRetry}>
        read again
      </button>
    </span>
  );
}
