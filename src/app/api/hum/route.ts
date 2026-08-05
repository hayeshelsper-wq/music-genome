// Hum-to-Genome intake: store the raw hum, transcribe it (pyin), render the
// notes to a clean piano take, CLAP-embed that render, place it on the Living
// Map, and register the hum as a library upload.

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { cloudRunAuthHeader } from "@/lib/cloudRun";
import { analyzeClip } from "@/lib/musicgen";
import { uploadAudio, signedOrProxyUrl } from "@/lib/storage";
import { saveUpload, saveSymbolic, SymbolicMelody } from "@/lib/store";
import { renderMidi } from "@/lib/symbolic";
import { atlasReady, placeByVector } from "@/lib/atlas";
import { extForMime } from "@/lib/recorderMime";
import { MelodicDna } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

interface TranscribeOut {
  error?: string;
  notes: SymbolicMelody["notes"];
  notes_quantized?: SymbolicMelody["notes"];
  source: "pyin";
  stem: string;
  dna: MelodicDna;
  midi_b64?: string;
  bpm?: number | null;
}

export async function POST(req: NextRequest) {
  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "multipart form with a file required" }, { status: 400 });
  }
  if (!file || !file.size) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }

  try {
    const humId = randomUUID();
    const mime = file.type || "audio/webm";
    const ext = extForMime(mime);
    const buf = Buffer.from(await file.arrayBuffer());
    const rawPath = `hums/${humId}.${ext}`;
    await uploadAudio(rawPath, buf, mime);

    // Transcribe the hum (mono pyin path + 1/8-grid quantization).
    const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(buf)], { type: mime }), `hum.${ext}`);
    fd.append("mode", "mono");
    const tRes = await fetch(`${AUDIO_SERVICE}/transcribe`, {
      method: "POST",
      headers: { ...auth },
      body: fd,
      signal: AbortSignal.timeout(120_000),
    });
    if (!tRes.ok) throw new Error(`audio-service /transcribe ${tRes.status}`);
    const t = (await tRes.json()) as TranscribeOut;
    if (t.error) throw new Error(`transcribe failed: ${t.error}`);
    if (!t.notes?.length) {
      return NextResponse.json(
        { error: "couldn't hear a melody in that — try humming louder and closer to the mic" },
        { status: 422 }
      );
    }

    // Clean piano render of the melody (better CLAP + conditioning source than
    // the raw hum).
    const render = await renderMidi(t.notes, t.bpm ?? null, 0);
    const renderPath = `hums/${humId}.render.wav`;
    await uploadAudio(renderPath, render.wav, "audio/wav");

    // CLAP-embed the render and place it on the map.
    const gen = await analyzeClip(render.wav);
    const map =
      atlasReady() && gen.embedding ? placeByVector(gen.embedding) : null;

    // Enter the library as a normal upload record.
    const title = `Hum — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const durationSec = Math.max(...t.notes.map((n) => n.e));
    await saveUpload({
      id: humId,
      title,
      artist: "you",
      filename: `hum.${ext}`,
      createdAt: Date.now(),
      audioPath: rawPath,
      audioContentType: mime,
      analysisStatus: "complete",
      features: gen.features,
      sections: [],
      chromagram: null,
      review: "",
      tags: gen.tags ?? null,
      ...(gen.embedding ? { embedding: gen.embedding } : {}),
      model: "",
      durationSec: Math.round(durationSec * 10) / 10,
      key: gen.features?.key,
      tempo: t.bpm ?? gen.features?.tempo_bpm,
    });
    await saveSymbolic("uploads", humId, {
      notes: t.notes,
      source: "pyin",
      stem: "raw",
      dna: t.dna,
      midi_b64: t.midi_b64,
      bpm: t.bpm ?? null,
    }).catch(() => {});

    return NextResponse.json({
      humId,
      notes: t.notes,
      notesQuantized: t.notes_quantized || [],
      bpm: t.bpm ?? null,
      map,
      renderUrl: signedOrProxyUrl(renderPath),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "hum processing failed" },
      { status: 502 }
    );
  }
}
