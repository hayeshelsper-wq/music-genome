import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { appOrigin, exchangeCode, setTokenCookies } from "@/lib/spotify";

export const dynamic = "force-dynamic";

// Spotify redirects back here with ?code & ?state. Verify state (CSRF), trade the
// code + PKCE verifier for tokens, persist them, then land on the playlist picker.
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthErr = url.searchParams.get("error");

  const c = await cookies();
  const verifier = c.get("sp_pkce")?.value;
  const expectedState = c.get("sp_state")?.value;

  // Land on the canonical origin (where the session cookies were just set), not
  // url.origin — the dev server's nextUrl can report localhost for a 127.0.0.1 hit.
  const dest = new URL("/playlists", appOrigin());

  if (oauthErr) {
    dest.searchParams.set("error", oauthErr); // e.g. "access_denied"
    return NextResponse.redirect(dest);
  }
  if (!code || !verifier || !state || state !== expectedState) {
    dest.searchParams.set("error", "auth_failed");
    return NextResponse.redirect(dest);
  }

  try {
    const tokens = await exchangeCode(code, verifier);
    const res = NextResponse.redirect(dest);
    setTokenCookies(res, tokens);
    res.cookies.delete("sp_pkce");
    res.cookies.delete("sp_state");
    return res;
  } catch {
    dest.searchParams.set("error", "token_exchange");
    return NextResponse.redirect(dest);
  }
}
