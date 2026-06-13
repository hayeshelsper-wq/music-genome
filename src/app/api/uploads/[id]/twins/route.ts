import { NextRequest, NextResponse } from "next/server";
import { getUploadVector, findNearestUploads } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Sonic Twins" — tracks in the library that sound closest to this one, via KNN
// over the CLAP audio vectors (audio→audio, excludes the track itself).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const vec = await getUploadVector(id);
    if (!vec) return NextResponse.json({ hits: [] }); // not embedded yet
    const hits = await findNearestUploads(vec, 6, id);
    return NextResponse.json({ hits });
  } catch (e) {
    return NextResponse.json(
      { hits: [], error: e instanceof Error ? e.message : "failed" },
      { status: 500 }
    );
  }
}
