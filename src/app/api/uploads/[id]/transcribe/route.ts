// Transcribe a library upload: stream its stored audio bytes to the
// audio-service and cache the symbolic melody under the upload's doc.

import { NextRequest, NextResponse } from "next/server";
import { getUpload } from "@/lib/store";
import { readAudio } from "@/lib/storage";
import { transcribeTrack } from "@/lib/symbolic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rec = await getUpload(id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });

  let mode: "melody" | "full" | "mono" = "full";
  try {
    const body = await req.json();
    if (body?.mode === "melody" || body?.mode === "mono") mode = body.mode;
  } catch {
    // no body → default mode
  }

  try {
    const buf = await readAudio(rec.audioPath);
    const melody = await transcribeTrack({
      uploadId: id,
      audio: { buf, filename: rec.filename || `${id}.mp3` },
      mode,
    });
    const { midi_b64: _midi, ...light } = melody;
    void _midi;
    return NextResponse.json({
      ...light,
      midiUrl: `/api/track/midi?scope=uploads&key=${encodeURIComponent(id)}`,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "transcription failed" },
      { status: 502 }
    );
  }
}
