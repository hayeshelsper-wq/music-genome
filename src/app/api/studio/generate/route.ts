// Genome Studio — the analyze → generate → verify loop.
//
// 1. Build a "reference" from measured DNA: a library track's stored DSP +
//    CLAP vector, or an artist's representative top track (analyzed on the fly).
// 2. Assemble a MusicGen prompt from that DNA and generate a clip on the GPU.
// 3. Run the generated clip back through the SAME analysis pipeline (/upload:
//    DSP features + CLAP embedding) and score how close it landed.

import { NextRequest, NextResponse } from "next/server";
import { getUpload, getUploadVector, getReport, isIngested } from "@/lib/store";
import { ingestArtist } from "@/lib/ingest";
import { getTopTracks } from "@/lib/itunes";
import { cloudRunAuthHeader } from "@/lib/cloudRun";
import { generateMusic, analyzeClip } from "@/lib/musicgen";
import { buildPrompt, scoreDna, Reference } from "@/lib/genomePrompt";
import { TrackFeatures } from "@/lib/trackReview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Generation on a cold L4 (model load) + analysis can run long; give it room.
export const maxDuration = 300;

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

async function analyzePreview(
  previewUrl: string
): Promise<{ features: TrackFeatures; embedding?: number[] | null; tags?: unknown }> {
  const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
  const res = await fetch(`${AUDIO_SERVICE}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ previewUrl }),
  });
  if (!res.ok) throw new Error(`audio-service /analyze ${res.status}`);
  return (await res.json()) as { features: TrackFeatures; embedding?: number[] | null };
}

async function buildReference(source: {
  kind: string;
  id?: string;
  mbid?: string;
}): Promise<Reference> {
  if (source.kind === "track") {
    const rec = await getUpload(source.id || "");
    if (!rec || !rec.features) throw new Error("track not found or not analyzed");
    const embedding = await getUploadVector(source.id || "");
    return {
      label: rec.title,
      artist: rec.artist,
      kind: "track",
      features: rec.features as TrackFeatures,
      tags: rec.tags,
      embedding,
    };
  }
  // artist: use a representative top track as the measurable reference.
  const mbid = source.mbid || "";
  if (!(await isIngested(mbid))) await ingestArtist(mbid);
  const report = await getReport(mbid);
  if (!report) throw new Error("artist not found");
  const tracks = await getTopTracks(report.artist.name);
  const top = tracks.find((t) => t.previewUrl);
  if (!top?.previewUrl) throw new Error("no playable tracks for this artist");
  const a = await analyzePreview(top.previewUrl);
  if (!a.features) throw new Error("could not analyze the reference track");
  return {
    label: top.title,
    artist: report.artist.name,
    kind: "artist",
    features: a.features,
    tags: (a as { tags?: Reference["tags"] }).tags ?? null,
    embedding: a.embedding,
  };
}

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
    const prompt = buildPrompt(reference);

    const wav = await generateMusic(prompt, durationSec);
    const gen = await analyzeClip(wav);
    if (!gen.features) throw new Error("generated clip analysis returned no features");

    const scorecard = scoreDna(reference, {
      features: gen.features,
      embedding: gen.embedding,
    });

    return NextResponse.json({
      prompt,
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
