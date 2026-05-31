import { NextRequest, NextResponse } from "next/server";
import { buildReport } from "@/lib/ingest";
import { writeNarrative } from "@/lib/narrative";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ mbid: string }> }
) {
  const { mbid } = await params;
  try {
    const report = await buildReport(mbid);
    const narrative = await writeNarrative(report);
    return NextResponse.json({ narrative });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
