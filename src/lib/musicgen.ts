// Client for the MusicGen GPU service (private Cloud Run L4, IAM-gated) and a
// helper to push a generated clip back through the existing /upload analysis so
// the Genome Studio can score it with the same tools that measured the source.

import { cloudRunAuthHeader } from "./cloudRun";
import { TrackFeatures, TagSet } from "./trackReview";

const MUSICGEN_URL = process.env.MUSICGEN_URL || "http://127.0.0.1:8090";
const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

export async function generateMusic(
  prompt: string,
  durationSec = 10,
  timeoutMs = 240_000
): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const auth = await cloudRunAuthHeader(MUSICGEN_URL);
    const res = await fetch(`${MUSICGEN_URL}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ prompt, duration_sec: durationSec }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`musicgen ${res.status} ${body.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export interface AnalyzedClip {
  features: TrackFeatures;
  embedding?: number[] | null;
  tags?: TagSet | null;
}

/** Analyze raw audio bytes via the audio-service /upload endpoint (whole-clip
 *  DSP features + CLAP embedding) — the verify half of the loop. */
export async function analyzeClip(wav: Buffer): Promise<AnalyzedClip> {
  const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "generated.wav");
  const res = await fetch(`${AUDIO_SERVICE}/upload`, {
    method: "POST",
    headers: { ...auth }, // let fetch set multipart boundary
    body: fd,
  });
  if (!res.ok) throw new Error(`audio-service /upload ${res.status}`);
  const j = (await res.json()) as AnalyzedClip & { error?: string };
  if (j.error) throw new Error(`analyze failed: ${j.error}`);
  return j;
}
