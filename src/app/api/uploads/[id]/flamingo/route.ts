import { NextRequest, NextResponse } from "next/server";
import { backfillUploadFlamingo } from "@/lib/uploadFlamingo";

export const runtime = "nodejs";
export const maxDuration = 360; // a cold GPU (image pull + load + inference) is ~4 min

// Client-polled Flamingo backfill for an upload whose GPU was cold. Thin wrapper
// over the shared backfill (also used by the server-side sweep so it finishes even
// if the user navigates away).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // ?force=1 re-runs Flamingo even if a read already exists — used to reprocess
  // older uploads with the new full-track window (was a single 30s window).
  const force = req.nextUrl.searchParams.get("force") === "1";
  const res = await backfillUploadFlamingo(id, force ? { force: true } : {});
  if (res.status === "complete")
    return NextResponse.json({
      flamingo: res.flamingo,
      breakdown: res.breakdown,
      flamingoStatus: "complete",
    });
  if (res.status === "error")
    return NextResponse.json(
      { error: res.error, flamingoStatus: "pending" },
      { status: 500 }
    );
  // pending / skip → tell the client to keep polling
  return NextResponse.json({ flamingoStatus: "pending", flamingo: "" });
}
