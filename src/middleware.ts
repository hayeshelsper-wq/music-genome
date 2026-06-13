import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, verifyToken } from "@/lib/auth";

// Paths reachable without a session (the login flow itself).
const OPEN = ["/login", "/api/auth/login", "/api/auth/logout"];

export async function middleware(req: NextRequest) {
  const password = process.env.AUTH_PASSWORD;
  const secret = process.env.AUTH_SECRET;
  // No auth configured (e.g. local dev) → don't gate anything.
  if (!password || !secret) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (OPEN.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }
  // Cron/sweep endpoints authenticate via CRON_SECRET, not the session cookie —
  // let them past the password gate (Cloud Scheduler can't log in).
  if (pathname.startsWith("/api/cron/")) {
    return NextResponse.next();
  }

  if (await verifyToken(req.cookies.get(AUTH_COOKIE)?.value, secret)) {
    return NextResponse.next();
  }

  // Block API calls outright; bounce page requests to the login screen.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?from=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

// Run on everything except Next's static assets.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
