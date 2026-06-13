import { NextRequest, NextResponse } from "next/server";
import { cloudRunAuthHeader } from "@/lib/cloudRun";
import { findNearestUploads } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

// "Search by sound" — embed the natural-language query into CLAP's joint
// text+audio space, then KNN against the stored per-track audio vectors.
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ hits: [] });
  try {
    const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
    const r = await fetch(`${AUDIO_SERVICE}/embed-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ text: q }),
    });
    const j = r.ok ? await r.json() : {};
    const vec = j.embedding as number[] | null;
    if (!Array.isArray(vec))
      return NextResponse.json({ hits: [], error: "embedding unavailable" });
    const hits = await findNearestUploads(vec, 12);
    return NextResponse.json({ q, hits });
  } catch (e) {
    return NextResponse.json(
      { hits: [], error: e instanceof Error ? e.message : "failed" },
      { status: 500 }
    );
  }
}
