import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, getPlaylist, setTokenCookies } from "@/lib/spotify";

export const dynamic = "force-dynamic";

// Full track list for one playlist — name, artists, album, duration, and the
// ISRC we'll later resolve to a MusicBrainz MBID to drive the enrichment feed.
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const { token, refreshed } = await getAccessToken();
  if (!token)
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  try {
    const playlist = await getPlaylist(token, id);
    const res = NextResponse.json(playlist);
    if (refreshed) setTokenCookies(res, refreshed);
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "spotify error" },
      { status: 502 }
    );
  }
}
