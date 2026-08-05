// Past optimizer runs: the list view returns light summaries; ?id= returns one
// full run (attempts included, with playable proxy URLs) for the read-only
// timeline at /studio?run=<id>.

import { NextRequest, NextResponse } from "next/server";
import { getStudioRun, listStudioRuns } from "@/lib/store";
import { signedOrProxyUrl } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  try {
    if (id) {
      const run = await getStudioRun(id);
      if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
      return NextResponse.json({
        ...run,
        attempts: run.attempts.map((a) => ({
          ...a,
          url: signedOrProxyUrl(a.audioPath),
        })),
      });
    }
    const runs = await listStudioRuns(20);
    return NextResponse.json({
      runs: runs.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        engine: r.engine,
        referenceLabel: r.referenceLabel,
        status: r.status,
        stopReason: r.stopReason,
        attemptCount: r.attempts.length,
        best: r.attempts.length
          ? Math.max(...r.attempts.map((a) => a.dnaMatch))
          : 0,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 502 }
    );
  }
}
