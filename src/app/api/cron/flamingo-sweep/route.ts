import { NextRequest, NextResponse } from "next/server";
import { listPendingFlamingo } from "@/lib/store";
import { backfillUploadFlamingo } from "@/lib/uploadFlamingo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 360;

// Server-side sweeper: completes the Flamingo read for any upload still "pending"
// — INDEPENDENT of any open page. Called by Cloud Scheduler every few minutes
// (auth via the CRON_SECRET header/param; this path is allowlisted in middleware).
// The first run on a cold GPU warms it (and returns pending); a later run lands
// the read and writes the DB. So an upload finishes even if the user navigated away.
//
// Bounded by time: we process pending uploads until ~300s elapsed so we never
// exceed the request budget. Cold attempts self-cap at 280s (see uploadFlamingo).
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const given =
    req.headers.get("x-cron-key") || req.nextUrl.searchParams.get("key");
  if (!secret || given !== secret)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const started = Date.now();
  const ids = await listPendingFlamingo(10);
  const results: Record<string, string> = {};
  for (const id of ids) {
    if (Date.now() - started > 300_000) {
      results[id] = "deferred"; // out of time this run; next sweep picks it up
      continue;
    }
    const r = await backfillUploadFlamingo(id);
    results[id] = r.status;
  }
  return NextResponse.json({ pending: ids.length, results });
}
