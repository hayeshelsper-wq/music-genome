// Symbolic-layer client: transcribe tracks through the audio-service, persist
// the result in Firestore (read-through cache — transcription runs Demucs +
// basic-pitch, so repeat views must be free), and compare composition DNA.

import { cloudRunAuthHeader } from "./cloudRun";
import { getSymbolic, saveSymbolic, SymbolicMelody, xrayKey } from "./store";
import { MelodicDna } from "./types";

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

export interface TranscribeArgs {
  previewUrl?: string;
  uploadId?: string;
  uploadUrl?: string; // resolved GCS-proxied URL for an upload (caller provides)
  audio?: { buf: Buffer; filename: string }; // raw bytes (uploads, hums)
  artist?: string; // with title → xray cache key for preview transcriptions
  title?: string;
  mode?: "melody" | "full" | "mono";
  keyRoot?: number;
}

function cacheKeyFor(args: TranscribeArgs): { scope: "uploads" | "xrays"; key: string } | null {
  if (args.uploadId) return { scope: "uploads", key: args.uploadId };
  if (args.artist && args.title) return { scope: "xrays", key: xrayKey(args.artist, args.title) };
  return null;
}

export async function transcribeTrack(args: TranscribeArgs): Promise<SymbolicMelody> {
  const mode = args.mode || "melody";
  const cache = cacheKeyFor(args);
  if (cache) {
    const hit = await getSymbolic(cache.scope, cache.key).catch(() => null);
    if (hit && hit.notes?.length) {
      console.log(`[symbolic] cache hit ${cache.scope}/${cache.key} — no re-transcription`);
      return hit;
    }
  }

  const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
  let res: Response;
  if (args.audio) {
    const fd = new FormData();
    fd.append(
      "file",
      new Blob([new Uint8Array(args.audio.buf)]),
      args.audio.filename
    );
    fd.append("mode", mode);
    fd.append("key_root", String(args.keyRoot || 0));
    res = await fetch(`${AUDIO_SERVICE}/transcribe`, {
      method: "POST",
      headers: { ...auth }, // let fetch set the multipart boundary
      body: fd,
      signal: AbortSignal.timeout(180_000),
    });
  } else {
    const url = args.previewUrl || args.uploadUrl;
    if (!url) throw new Error("no audio source to transcribe");
    res = await fetch(`${AUDIO_SERVICE}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        ...(args.previewUrl ? { previewUrl: args.previewUrl } : { uploadUrl: args.uploadUrl }),
        mode,
        key_root: args.keyRoot || 0,
      }),
      signal: AbortSignal.timeout(180_000),
    });
  }
  if (!res.ok) throw new Error(`audio-service /transcribe ${res.status}`);
  const j = (await res.json()) as {
    error?: string;
    notes: SymbolicMelody["notes"];
    source: SymbolicMelody["source"];
    stem: string;
    dna: MelodicDna;
    midi_b64?: string;
    bpm?: number | null;
  };
  if (j.error) throw new Error(`transcribe failed: ${j.error}`);

  const rec: SymbolicMelody = {
    notes: j.notes || [],
    source: j.source,
    stem: j.stem,
    dna: j.dna,
    midi_b64: j.midi_b64,
    bpm: j.bpm ?? null,
  };
  if (cache && rec.notes.length) {
    await saveSymbolic(cache.scope, cache.key, rec).catch(() => {});
  }
  return rec;
}

function cos(a: number[], b: number[]): number {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Composition similarity between two melodic-DNA fingerprints, 0..1. */
export function melodicSimilarity(a: MelodicDna, b: MelodicDna): number {
  const s =
    0.5 * cos(a.interval_hist, b.interval_hist) +
    0.25 * cos(a.pitch_class_dist, b.pitch_class_dist) +
    0.25 * cos(a.rhythm_hist, b.rhythm_hist);
  return Math.max(0, Math.min(1, s));
}
