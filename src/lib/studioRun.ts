// Shared Studio helpers: build a measurable "reference" from a library track
// or an artist's representative top track, and analyze preview URLs through the
// audio-service. Extracted from /api/studio/generate so the one-shot route and
// the optimizer loop share identical behavior.

import { getUpload, getUploadVector, getReport, isIngested } from "./store";
import { ingestArtist } from "./ingest";
import { getTopTracks } from "./itunes";
import { cloudRunAuthHeader } from "./cloudRun";
import { Reference } from "./genomePrompt";
import { callFlamingo } from "./trackAudio";
import { TrackFeatures } from "./trackReview";

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

export async function analyzePreview(
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

export async function buildReference(source: {
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
      // The upload pipeline already ran Flamingo and stored its read — reuse it
      // (no extra GPU call) so Claude can write a prompt grounded in what the
      // track actually sounds like.
      flamingo: rec.flamingo || null,
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
  // Best-effort Flamingo read of the preview (skipped if the GPU is cold — the
  // prompt composer falls back to DSP+tags). Never block generation on it.
  const fl = await callFlamingo(top.previewUrl, { requireWarm: false }).catch(() => ({ text: "" }));
  return {
    label: top.title,
    artist: report.artist.name,
    kind: "artist",
    features: a.features,
    tags: (a as { tags?: Reference["tags"] }).tags ?? null,
    embedding: a.embedding,
    flamingo: fl.text || null,
  };
}
