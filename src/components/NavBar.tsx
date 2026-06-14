"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const NAV = [
  { href: "/ask", label: "Ask" },
  { href: "/studio", label: "Studio" },
  { href: "/trail", label: "Trails" },
  { href: "/lineage", label: "Lineage" },
  { href: "/atlas", label: "Map" },
  { href: "/mashup", label: "Mashup" },
  { href: "/showcase", label: "X-Rays" },
  { href: "/library", label: "Library" },
];

export default function NavBar() {
  const pathname = usePathname() || "/";
  const [open, setOpen] = useState(false);

  // Close the mobile menu whenever we navigate to a new route.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // The login gate stands alone — no nav.
  if (pathname === "/login") return null;

  return (
    <header className="nav">
      <div className="nav-inner">
        <Link href="/" className="nav-logo">🧬 <span>Music Genome</span></Link>
        <button
          type="button"
          className="nav-toggle"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          )}
        </button>
        <nav className={`nav-links ${open ? "open" : ""}`}>
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={pathname.startsWith(n.href) ? "active" : ""}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
