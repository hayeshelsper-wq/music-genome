// Audible Influence Trails — quantify the sonic inheritance between two artists.
//
// For each artist we build a "sonic fingerprint": the CLAP-embedding centroid of
// their top iTunes-preview tracks plus aggregate measured DSP (tempo, brightness,
// texture, …). We then compare two fingerprints — cosine similarity in CLAP space
// + concrete DSP deltas — so the family tree can be *heard* and measured, not just
// looked at. Fingerprints are cached in Firestore (see store.ts).

import { cloudRunAuthHeader } from "./cloudRun";
import { getTopTracks } from "./itunes";
import { ArtistSonic, getArtistSonic, saveArtistSonic } from "./store";

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";
// Tracks averaged into each artist's fingerprint. More = steadier centroid but
// more (cached) audio-service calls; 3 is a good balance for a demo.
const TOP_N = Number(process.env.TRAIL_TRACKS || 3);

interface AnalyzedPreview {
  features: Record<string, unknown>;
  embedding: number[] | null;
}

async function analyzePreview(previewUrl: string): Promise<AnalyzedPreview> {
  const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
  const res = await fetch(`${AUDIO_SERVICE}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ previewUrl }),
  });
  if (!res.ok) throw new Error(`audio-service /analyze ${res.status}`);
  const j = (await res.json()) as AnalyzedPreview & { error?: string };
  return { features: j.features || {}, embedding: Array.isArray(j.embedding) ? j.embedding : null };
}

function centroid(vectors: number[][]): number[] {
  const n = vectors.length;
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= n;
  return out;
}

function avg(nums: number[]): number | undefined {
  const xs = nums.filter((n) => typeof n === "number" && Number.isFinite(n));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

function mode(vals: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of vals) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let max = 0;
  for (const [k, c] of counts) if (c > max) { max = c; best = k; }
  return best;
}

const num = (f: Record<string, unknown>, k: string) =>
  typeof f[k] === "number" ? (f[k] as number) : NaN;
const str = (f: Record<string, unknown>, k: string) =>
  typeof f[k] === "string" ? (f[k] as string) : undefined;

/** Build (or read from cache) an artist's sonic fingerprint. */
export async function computeArtistSonic(
  mbid: string,
  name: string
): Promise<ArtistSonic> {
  const cached = await getArtistSonic(mbid);
  if (cached && Array.isArray(cached.embedding) && cached.embedding.length) return cached;

  const tracks = (await getTopTracks(name)).filter((t) => t.previewUrl).slice(0, TOP_N);
  if (!tracks.length) throw new Error(`No playable previews found for ${name}.`);

  const analyses: { features: Record<string, unknown>; embedding: number[] }[] = [];
  for (const t of tracks) {
    try {
      const a = await analyzePreview(t.previewUrl!);
      if (a.embedding) analyses.push({ features: a.features, embedding: a.embedding });
    } catch {
      /* skip a track that fails to analyze; the centroid uses the rest */
    }
  }
  if (!analyses.length) throw new Error(`Could not analyze any tracks for ${name}.`);

  const feats = analyses.map((a) => a.features);
  const rec: ArtistSonic = {
    mbid,
    name,
    tempo_bpm: round(avg(feats.map((f) => num(f, "tempo_bpm")))),
    brightness_hz: round(avg(feats.map((f) => num(f, "brightness_hz")))),
    brightness: mode(feats.map((f) => str(f, "brightness"))),
    texture: mode(feats.map((f) => str(f, "texture"))),
    density: mode(feats.map((f) => str(f, "density"))),
    dynamics: mode(feats.map((f) => str(f, "dynamics"))),
    energy_shape: mode(feats.map((f) => str(f, "energy_shape"))),
    key: str(feats[0], "key"),
    tracks: tracks
      .filter((_t, i) => i < analyses.length)
      .map((t) => ({ title: t.title, previewUrl: t.previewUrl!, artworkUrl: t.artworkUrl })),
    embedding: centroid(analyses.map((a) => a.embedding)),
    trackCount: analyses.length,
    computedAt: Date.now(),
  };
  await saveArtistSonic(rec);
  return rec;
}

function round(n: number | undefined): number | undefined {
  return typeof n === "number" ? Math.round(n) : undefined;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const dim = Math.min(a.length, b.length);
  for (let i = 0; i < dim; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export interface SonicDelta {
  label: string;
  a: string;
  b: string;
  note?: string;
}

/** Concrete measured deltas between two fingerprints (a = earlier, b = later). */
export function sonicDeltas(a: ArtistSonic, b: ArtistSonic): SonicDelta[] {
  const d: SonicDelta[] = [];
  if (a.tempo_bpm && b.tempo_bpm) {
    const diff = b.tempo_bpm - a.tempo_bpm;
    d.push({
      label: "Tempo",
      a: `${a.tempo_bpm} BPM`,
      b: `${b.tempo_bpm} BPM`,
      note: Math.abs(diff) < 4 ? "≈ same pulse" : `${diff > 0 ? "+" : ""}${diff} BPM`,
    });
  }
  if (a.brightness_hz && b.brightness_hz) {
    const diff = b.brightness_hz - a.brightness_hz;
    d.push({
      label: "Brightness",
      a: `${a.brightness} (${a.brightness_hz} Hz)`,
      b: `${b.brightness} (${b.brightness_hz} Hz)`,
      note: Math.abs(diff) < 150 ? "≈ same" : `${diff > 0 ? "brighter +" : "darker "}${diff} Hz`,
    });
  }
  const cat = (label: string, key: keyof ArtistSonic) => {
    const av = a[key] as string | undefined;
    const bv = b[key] as string | undefined;
    if (av && bv) d.push({ label, a: av, b: bv, note: av === bv ? "carried over" : "shifted" });
  };
  cat("Texture", "texture");
  cat("Rhythmic density", "density");
  cat("Dynamics", "dynamics");
  cat("Energy shape", "energy_shape");
  if (a.key && b.key) d.push({ label: "Key center", a: a.key, b: b.key });
  return d;
}
