// Mashup Lab — proxy to the audio-service /mashup endpoint (Demucs separation +
// time-stretch/pitch-shift conform + mix). Returns a base64 wav data URL + the
// measured conform metadata.

import { NextRequest, NextResponse } from "next/server";
import { cloudRunAuthHeader } from "@/lib/cloudRun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Two Demucs separations on a cold CPU service + stretch/shift can run long.
export const maxDuration = 300;

const AUDIO = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

export async function POST(req: NextRequest) {
  let body: { aUrl?: string; bUrl?: string; aStems?: string[]; bStems?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!body.aUrl || !body.bUrl) return NextResponse.json({ error: "aUrl and bUrl required" }, { status: 400 });

  try {
    const auth = await cloudRunAuthHeader(AUDIO);
    const res = await fetch(`${AUDIO}/mashup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        aUrl: body.aUrl,
        bUrl: body.bUrl,
        aStems: body.aStems || ["vocals"],
        bStems: body.bStems || ["drums", "bass", "other"],
      }),
    });
    const data = await res.json();
    if (data.error || !data.audio) {
      return NextResponse.json({ error: data.error || "mashup failed" }, { status: 502 });
    }
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "mashup failed" }, { status: 502 });
  }
}
