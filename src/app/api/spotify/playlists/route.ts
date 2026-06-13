import { NextResponse } from "next/server";
import { getAccessToken, getMyPlaylists, setTokenCookies } from "@/lib/spotify";

export const dynamic = "force-dynamic";

// The signed-in user's playlists. 401 (not 500) when there's no session, so the
// UI can show a "Connect Spotify" button instead of an error.
export async function GET() {
  const { token, refreshed } = await getAccessToken();
  if (!token)
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  try {
    const playlists = await getMyPlaylists(token);
    const res = NextResponse.json({ playlists });
    if (refreshed) setTokenCookies(res, refreshed);
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "spotify error" },
      { status: 502 }
    );
  }
}
