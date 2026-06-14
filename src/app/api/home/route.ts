// Homepage "command center" data — a prerendered taste of the whole system,
// drawn from what's already been explored + stored. Best-effort: any piece that
// fails just comes back empty so the dashboard still renders.

import { NextResponse } from "next/server";
import { listArtistSonic, listUploads, countReports } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [artists, uploads, reportCount] = await Promise.all([
    listArtistSonic(8).catch(() => []),
    listUploads(60).catch(() => []),
    countReports().catch(() => 0),
  ]);

  return NextResponse.json({
    artists: artists.map((a) => ({
      mbid: a.mbid,
      name: a.name,
      tempo_bpm: a.tempo_bpm,
      key: a.key,
      brightness: a.brightness,
      track: a.tracks?.[0] || null,
    })),
    library: {
      count: uploads.length,
      recent: uploads.slice(0, 5).map((u) => u.title).filter(Boolean),
    },
    stats: {
      artistsMapped: reportCount,
      libraryTracks: uploads.length,
    },
  });
}
