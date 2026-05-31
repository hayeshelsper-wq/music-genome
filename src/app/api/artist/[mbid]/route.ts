import { NextRequest, NextResponse } from "next/server";
import { ingestArtist, buildReport } from "@/lib/ingest";
import { isIngested } from "@/lib/neo4j";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ mbid: string }> }
) {
  const { mbid } = await params;
  try {
    // Serve from the graph if we've seen this artist; otherwise ingest first.
    if (!(await isIngested(mbid))) {
      await ingestArtist(mbid);
    }
    const report = await buildReport(mbid);
    return NextResponse.json(report);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
