// Produce a hummed melody in a chosen style: musicgen-melody conditions on the
// clean piano render; acestep gets a symbolic description ("inspired by"). The
// result lands in the library, optionally with a melodic-fidelity scorecard.

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { cloudRunAuthHeader } from "@/lib/cloudRun";
import { generate, Engine } from "@/lib/generation";
import { analyzeClip } from "@/lib/musicgen";
import { scoreDna } from "@/lib/genomePrompt";
import { composeStudioPrompt } from "@/lib/studioPrompt";
import { buildReference } from "@/lib/studioRun";
import { melodicSimilarity, scoreHumFidelity } from "@/lib/symbolic";
import { getUpload, getSymbolic, saveUpload, listLoras } from "@/lib/store";
import { readAudio, uploadAudio, signedOrProxyUrl } from "@/lib/storage";
import { MelodicDna } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

function contour(notes: { p: number; s: number }[]): string {
  if (notes.length < 3) return "steady";
  const first = notes[0].p;
  const last = notes[notes.length - 1].p;
  const max = Math.max(...notes.map((n) => n.p));
  if (max > first + 2 && max > last + 2) return "arched (rises then falls)";
  if (last > first + 2) return "rising";
  if (first > last + 2) return "falling";
  return "steady";
}

export async function POST(req: NextRequest) {
  let body: {
    humId?: string;
    styleMbid?: string;
    styleUploadId?: string;
    loraId?: string;
    engine?: "musicgen-melody" | "acestep";
    durationSec?: number;
    verify?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.humId) return NextResponse.json({ error: "humId required" }, { status: 400 });
  const engine: Engine = body.engine === "acestep" ? "acestep" : "musicgen-melody";

  try {
    const [hum, humSym] = await Promise.all([
      getUpload(body.humId),
      getSymbolic("uploads", body.humId),
    ]);
    if (!hum || !humSym) return NextResponse.json({ error: "hum not found" }, { status: 404 });

    // Style reference: an artist, a library track, or (acestep) a LoRA voice.
    let loraGcs: string | null = null;
    let referenceSource: { kind: string; id?: string; mbid?: string } | null = null;
    if (body.styleMbid) referenceSource = { kind: "artist", mbid: body.styleMbid };
    else if (body.styleUploadId) referenceSource = { kind: "track", id: body.styleUploadId };
    if (body.loraId) {
      const lora = (await listLoras()).find((l) => l.id === body.loraId);
      if (!lora || lora.status !== "ready") {
        return NextResponse.json({ error: "that voice isn't trained yet" }, { status: 400 });
      }
      loraGcs = lora.gcsPath;
    }

    let prompt = "a melodic instrumental sketch, clean studio production";
    let referenceLabel = "base style";
    let reference = null;
    if (referenceSource) {
      reference = await buildReference(referenceSource);
      const composed = await composeStudioPrompt(reference);
      prompt = composed.prompt;
      referenceLabel = reference.artist
        ? `${reference.label} — ${reference.artist}`
        : reference.label;
    }

    const durationSec =
      engine === "acestep"
        ? Math.max(10, Math.min(120, body.durationSec || 30))
        : Math.max(4, Math.min(15, body.durationSec || 12));

    let melodyWavB64: string | null = null;
    if (engine === "musicgen-melody") {
      // Condition on the clean piano render, not the raw hum.
      const render = await readAudio(`hums/${body.humId}.render.wav`);
      melodyWavB64 = render.toString("base64");
    } else {
      const key = hum.key ? ` in ${hum.key}` : "";
      const bpm = hum.tempo ? ` around ${Math.round(hum.tempo)} BPM` : "";
      prompt += `. Built around a ${contour(humSym.notes)} lead melody${key}${bpm}, inspired by a hummed motif.`;
    }

    const wav = await generate(engine, {
      prompt,
      durationSec,
      seed: Math.floor(Math.random() * 1e9),
      melodyWavB64,
      loraGcs,
      timeoutMs: 300_000,
    });

    const producedId = randomUUID();
    const audioPath = `hums/${body.humId}/produced-${producedId}.wav`;
    await uploadAudio(audioPath, wav, "audio/wav");

    const gen = await analyzeClip(wav);
    const title = `Produced hum — ${referenceLabel}${engine === "acestep" ? " (inspired by)" : ""}`;
    await saveUpload({
      id: producedId,
      title,
      artist: "you + the genome",
      createdAt: Date.now(),
      audioPath,
      audioContentType: "audio/wav",
      analysisStatus: "complete",
      features: gen.features,
      sections: [],
      chromagram: null,
      review: "",
      tags: gen.tags ?? null,
      ...(gen.embedding ? { embedding: gen.embedding } : {}),
      model: engine,
      durationSec,
      key: gen.features?.key,
      tempo: gen.features?.tempo_bpm,
    });

    // Optional verify: DNA scorecard with the CLAP row swapped for melodic
    // fidelity (hum melody vs a transcription of the generated clip).
    let scorecard = null;
    let melodicFidelity: number | null = null;
    if (body.verify && reference && gen.features) {
      const base = scoreDna(reference, { features: gen.features, embedding: gen.embedding });
      try {
        const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
        const fd = new FormData();
        fd.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "gen.wav");
        fd.append("mode", "full");
        const tRes = await fetch(`${AUDIO_SERVICE}/transcribe`, {
          method: "POST",
          headers: { ...auth },
          body: fd,
          signal: AbortSignal.timeout(120_000),
        });
        const t = (await tRes.json()) as { dna?: MelodicDna; notes?: unknown[]; error?: string };
        if (tRes.ok && !t.error && t.dna && t.notes?.length) {
          melodicFidelity = melodicSimilarity(humSym.dna, t.dna);
          scorecard = scoreHumFidelity(base, melodicFidelity);
        } else {
          scorecard = base;
        }
      } catch {
        scorecard = base;
      }
    }

    return NextResponse.json({
      producedId,
      url: signedOrProxyUrl(audioPath),
      prompt,
      engine,
      referenceLabel,
      scorecard,
      melodicFidelity,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "production failed" },
      { status: 502 }
    );
  }
}
