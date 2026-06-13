import { NextRequest, NextResponse } from "next/server";
import { cloudRunAuthHeader } from "@/lib/cloudRun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

// Returns ONLY the CLAP text embedding for a query, so the static Sonic Map can
// score it client-side against its baked per-track vectors (spotlight search).
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ embedding: null });
  try {
    const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
    const r = await fetch(`${AUDIO_SERVICE}/embed-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ text: q }),
    });
    const j = r.ok ? await r.json() : {};
    const vec = Array.isArray(j.embedding) ? (j.embedding as number[]) : null;
    return NextResponse.json({ q, embedding: vec });
  } catch (e) {
    return NextResponse.json(
      { embedding: null, error: e instanceof Error ? e.message : "failed" },
      { status: 500 }
    );
  }
}
