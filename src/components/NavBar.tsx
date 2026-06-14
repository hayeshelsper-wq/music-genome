"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
  // The login gate stands alone — no nav.
  if (pathname === "/login") return null;

  return (
    <header className="nav">
      <div className="nav-inner">
        <Link href="/" className="nav-logo">🧬 <span>Music Genome</span></Link>
        <nav className="nav-links">
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
