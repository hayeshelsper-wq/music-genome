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

/** Slice a PCM16 WAV buffer down to its middle `seconds` — long ACE-Step clips
 *  are scored on a center cut so the analysis window matches what the 30s
 *  reference previews measure. Non-PCM16 (or short) input is returned whole. */
export function centerCutWav(buf: Buffer, seconds: number): Buffer {
  if (buf.length < 44) return buf;
  if (
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE" ||
    buf.toString("ascii", 36, 40) !== "data"
  ) {
    return buf;
  }
  const audioFormat = buf.readUInt16LE(20);
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (audioFormat !== 1 || bitsPerSample !== 16 || !channels || !sampleRate) return buf;

  const dataSize = Math.min(buf.readUInt32LE(40), buf.length - 44);
  const data = buf.subarray(44, 44 + dataSize);
  const frameBytes = channels * 2;
  const wantBytes = Math.floor((seconds * sampleRate)) * frameBytes;
  if (data.length <= wantBytes) return buf;

  const startRaw = Math.floor((data.length - wantBytes) / 2);
  const start = startRaw - (startRaw % frameBytes);
  const cut = data.subarray(start, start + wantBytes);
  const header = Buffer.from(buf.subarray(0, 44));
  header.writeUInt32LE(36 + cut.length, 4);
  header.writeUInt32LE(cut.length, 40);
  return Buffer.concat([header, cut]);
}

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
