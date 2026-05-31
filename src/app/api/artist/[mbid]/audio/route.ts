import { NextRequest, NextResponse } from "next/server";
import { getArtist } from "@/lib/musicbrainz";
import { getTopTracks } from "@/lib/itunes";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Fast path: playable 30s previews + album art from iTunes. Keyless and
 * Neo4j-free, so it works before the graph is configured. The slower
 * audio-feature analysis lives in a separate /audio-features route so it never
 * delays previews.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ mbid: string }> }
) {
  const { mbid } = await params;
  try {
    // The report page already knows the name; passing it skips a MusicBrainz call.
    const name =
      req.nextUrl.searchParams.get("name")?.trim() ||
      (await getArtist(mbid)).ref.name;

    const topTracks = await getTopTracks(name);
    return NextResponse.json({ artist: { mbid, name }, topTracks });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
