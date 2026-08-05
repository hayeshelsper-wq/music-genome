// Genome Studio — the analyze → generate → verify loop.
//
// 1. Build a "reference" from measured DNA: a library track's stored DSP +
//    CLAP vector, or an artist's representative top track (analyzed on the fly).
// 2. Assemble a MusicGen prompt from that DNA and generate a clip on the GPU.
// 3. Run the generated clip back through the SAME analysis pipeline (/upload:
//    DSP features + CLAP embedding) and score how close it landed.

import { NextRequest, NextResponse } from "next/server";
import { generateMusic, analyzeClip } from "@/lib/musicgen";
import { scoreDna } from "@/lib/genomePrompt";
import { composeStudioPrompt } from "@/lib/studioPrompt";
import { buildReference } from "@/lib/studioRun";
import { TrackFeatures } from "@/lib/trackReview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Generation on a cold L4 (model load) + analysis can run long; give it room.
export const maxDuration = 300;

function pickFeatures(f: TrackFeatures) {
  return {
    tempo_bpm: f.tempo_bpm,
    key: f.key,
    brightness: f.brightness,
    texture: f.texture,
    density: f.density,
    dynamics: f.dynamics,
    energy_shape: f.energy_shape,
  };
}

export async function POST(req: NextRequest) {
  if (!process.env.MUSICGEN_URL && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "MUSICGEN_URL not configured on this deployment." },
      { status: 400 }
    );
  }
  let body: { source?: { kind: string; id?: string; mbid?: string }; durationSec?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const source = body.source;
  if (!source?.kind) return NextResponse.json({ error: "source required" }, { status: 400 });
  const durationSec = Math.max(4, Math.min(15, body.durationSec || 10));

  try {
    const reference = await buildReference(source);
    const { prompt, source: promptSource, model: promptModel } =
      await composeStudioPrompt(reference);

    const wav = await generateMusic(prompt, durationSec);
    const gen = await analyzeClip(wav);
    if (!gen.features) throw new Error("generated clip analysis returned no features");

    const scorecard = scoreDna(reference, {
      features: gen.features,
      embedding: gen.embedding,
    });

    return NextResponse.json({
      prompt,
      promptSource,
      promptModel,
      referenceHeard: !!reference.flamingo,
      reference: {
        label: reference.label,
        artist: reference.artist,
        kind: reference.kind,
        features: pickFeatures(reference.features),
        tags: reference.tags,
      },
      generated: {
        features: pickFeatures(gen.features),
        tags: gen.tags,
        durationSec,
      },
      scorecard,
      clip: `data:audio/wav;base64,${wav.toString("base64")}`,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "generation failed" },
      { status: 502 }
    );
  }
}
