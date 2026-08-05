// Melody transcription of a catalog track (30s preview): Demucs vocals stem →
// basic-pitch → notes + composition DNA, cached in Firestore by artist+title.

import { NextRequest, NextResponse } from "next/server";
import { transcribeTrack } from "@/lib/symbolic";
import { xrayKey } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: {
    previewUrl?: string;
    artist?: string;
    title?: string;
    mode?: "melody" | "full" | "mono";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.previewUrl) {
    return NextResponse.json({ error: "previewUrl required" }, { status: 400 });
  }
  try {
    const rec = await transcribeTrack({
      previewUrl: body.previewUrl,
      artist: body.artist,
      title: body.title,
      mode: body.mode || "melody",
    });
    const { midi_b64: _midi, ...light } = rec;
    void _midi;
    return NextResponse.json({
      ...light,
      midiUrl:
        body.artist && body.title
          ? `/api/track/midi?scope=xrays&key=${encodeURIComponent(xrayKey(body.artist, body.title))}`
          : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "transcription failed" },
      { status: 502 }
    );
  }
}
