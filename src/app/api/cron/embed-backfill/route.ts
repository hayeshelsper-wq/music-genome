import { NextRequest, NextResponse } from "next/server";
import { listMissingEmbedding, getUpload, patchUpload } from "@/lib/store";
import { audioObject } from "@/lib/storage";
import { cloudRunAuthHeader } from "@/lib/cloudRun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

// Backfill CLAP vectors for uploads analyzed before CLAP existed. Secret-gated
// (allowlisted in middleware). Going forward new uploads embed during /analyze;
// this catches the back-catalog. Idempotent + bounded by time.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const given =
    req.headers.get("x-cron-key") || req.nextUrl.searchParams.get("key");
  if (!secret || given !== secret)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const started = Date.now();
  const all = req.nextUrl.searchParams.get("all") === "1";
  const ids = await listMissingEmbedding(50, all);
  const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
  const results: Record<string, string> = {};
  for (const id of ids) {
    if (Date.now() - started > 250_000) {
      results[id] = "deferred";
      continue;
    }
    try {
      const rec = await getUpload(id);
      if (!rec?.audioPath) {
        results[id] = "no-audio";
        continue;
      }
      const [buf] = await audioObject(rec.audioPath).download();
      const fwd = new FormData();
      fwd.append(
        "file",
        new Blob([new Uint8Array(buf)], {
          type: rec.audioContentType || "audio/mpeg",
        }),
        rec.filename || "audio"
      );
      const r = await fetch(`${AUDIO_SERVICE}/embed-clip`, {
        method: "POST",
        headers: { ...auth },
        body: fwd,
      });
      const j = r.ok ? await r.json() : {};
      const vec = j.embedding as number[] | null;
      if (Array.isArray(vec)) {
        await patchUpload(id, { embedding: vec });
        results[id] = "embedded";
      } else {
        results[id] = "embed-failed";
      }
    } catch (e) {
      results[id] = `error: ${e instanceof Error ? e.message.slice(0, 80) : "x"}`;
    }
  }
  return NextResponse.json({ missing: ids.length, results });
}
