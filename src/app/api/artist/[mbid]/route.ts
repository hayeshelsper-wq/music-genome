import { NextRequest, NextResponse } from "next/server";
import { ingestArtist, buildReport } from "@/lib/ingest";
import { isIngested, classifyStoreError } from "@/lib/store";

export const dynamic = "force-dynamic";
// First-time ingest of a new artist serially hits MusicBrainz (1 req/s) +
// Wikidata + Last.fm, which can run ~70s — keep headroom above the default cap.
export const maxDuration = 120;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ mbid: string }> }
) {
  const { mbid } = await params;
  try {
    // Serve the stored report if we've seen this artist; otherwise ingest first.
    if (!(await isIngested(mbid))) {
      await ingestArtist(mbid);
    }
    const report = await buildReport(mbid);
    return NextResponse.json(report);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "failed";
    // Tell the client WHY so it shows the right thing: a setup prompt only when
    // the data store isn't configured (no GCP creds); a transient "retry"
    // otherwise; a generic error for everything else.
    const code = classifyStoreError(e);
    const status = code === "error" ? 502 : 503;
    return NextResponse.json({ error: message, code }, { status });
  }
}
