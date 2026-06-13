import { NextRequest, NextResponse } from "next/server";
import {
  appOrigin,
  authorizeUrl,
  clientId,
  makePkce,
  randomState,
} from "@/lib/spotify";

export const dynamic = "force-dynamic";

// Kick off Authorization Code + PKCE: stash the verifier + state in short-lived
// httpOnly cookies, then bounce the user to Spotify's consent screen.
export async function GET(req: NextRequest) {
  if (!clientId()) {
    return NextResponse.json(
      { error: "SPOTIFY_CLIENT_ID not set in .env.local" },
      { status: 500 }
    );
  }

  // Spotify forces the callback to 127.0.0.1 (it banned `localhost`). If the user
  // started on `localhost`, the PKCE/state cookies would be set on the localhost
  // origin and be invisible to the 127.0.0.1 callback — a different origin — so
  // auth fails. Bounce to the canonical origin FIRST (before setting cookies),
  // using the real Host header (req.nextUrl is unreliable on the dev server).
  const origin = appOrigin();
  const canonicalHost = new URL(origin).host; // e.g. "127.0.0.1:3000"
  const host = req.headers.get("host") || "";
  if (host && host !== canonicalHost) {
    return NextResponse.redirect(`${origin}/api/spotify/login`);
  }

  const { verifier, challenge } = makePkce();
  const state = randomState();
  const res = NextResponse.redirect(authorizeUrl(challenge, state));
  const opts = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 600 };
  res.cookies.set("sp_pkce", verifier, opts);
  res.cookies.set("sp_state", state, opts);
  return res;
}
