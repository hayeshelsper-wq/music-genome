// Genome Studio — turn measured DNA into a generation prompt, and score how
// close a generated clip landed. Pure functions (no I/O) so they're easy to test.

import { TrackFeatures, TagSet, TagItem } from "./trackReview";

export interface Reference {
  label: string; // e.g. track title, or "Karma Police"
  artist?: string;
  kind: "track" | "artist";
  features: TrackFeatures;
  tags?: TagSet | null;
  embedding?: number[] | null; // CLAP vector of the reference audio
}

function top(items: TagItem[] | undefined, n: number): string[] {
  return (items || [])
    .slice()
    .sort((a, b) => b.prob - a.prob)
    .slice(0, n)
    .map((t) => t.label.replace(/_/g, " "));
}

/** Compose a natural-language MusicGen prompt from a reference's measured DNA. */
export function buildPrompt(ref: Reference): string {
  const f = ref.features;
  const genres = top(ref.tags?.genres, 2);
  const moods = top(ref.tags?.moods, 2);
  const insts = top(ref.tags?.instruments, 3);

  const lead =
    [moods.join(", "), genres.join("/")].filter(Boolean).join(" ") || "expressive instrumental music";

  const bits: string[] = [`A ${lead} track`];
  if (f.tempo_bpm) bits.push(`at ${Math.round(f.tempo_bpm)} BPM`);
  if (f.key) bits.push(`in ${f.key}`);

  const texture: string[] = [];
  if (f.brightness) texture.push(`${f.brightness} timbre`);
  if (f.texture) texture.push(`${f.texture} texture`);
  if (f.density) texture.push(`${f.density} rhythmic density`);
  if (f.dynamics) texture.push(`${f.dynamics} dynamics`);
  let sentence = bits.join(" ") + ".";
  if (texture.length) sentence += ` ${cap(texture.join(", "))}.`;
  if (insts.length) sentence += ` Featuring ${insts.join(", ")}.`;
  if (f.energy_shape) sentence += ` Energy that ${f.energy_shape}.`;
  sentence += " Instrumental, studio-quality production.";
  return sentence;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---- scoring -------------------------------------------------------------

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const ENHARM: Record<string, string> = {
  Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#",
};

function parseKey(k?: string): { tonic: number; mode: string } | null {
  if (!k) return null;
  const m = k.trim().match(/^([A-G][#b]?)\s*(major|minor|maj|min)?/i);
  if (!m) return null;
  let root = m[1].replace(/^([A-G])b/, (_x, n) => ENHARM[n + "b"] || n);
  root = root.length === 2 ? root[0].toUpperCase() + root[1] : root.toUpperCase();
  const tonic = NOTES.indexOf(root);
  if (tonic < 0) return null;
  const mode = /min/i.test(m[2] || "") ? "minor" : "major";
  return { tonic, mode };
}

export interface DimScore {
  label: string;
  target: string;
  achieved: string;
  score: number; // 0..100
  detail?: string;
}

export interface Scorecard {
  overall: number; // 0..100 "DNA match"
  dims: DimScore[];
  clap: number | null; // cosine similarity 0..1, null if no reference vector
}

function cosine(a?: number[] | null, b?: number[] | null): number | null {
  if (!a || !b || a.length !== b.length || a.length === 0) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Score a generated clip's measured features + embedding against the reference. */
export function scoreDna(
  ref: Reference,
  gen: { features: TrackFeatures; embedding?: number[] | null }
): Scorecard {
  const dims: DimScore[] = [];

  // Tempo — tolerant of half/double-time (a common DSP/perception artifact).
  const tRef = ref.features.tempo_bpm;
  const tGen = gen.features.tempo_bpm;
  if (tRef && tGen) {
    const cands = [tGen, tGen * 2, tGen / 2];
    const best = cands.reduce(
      (m, c) => Math.min(m, Math.abs(c - tRef) / tRef),
      Infinity
    );
    const tempoScore = Math.max(0, Math.round((1 - Math.min(best, 1)) * 100));
    dims.push({
      label: "Tempo",
      target: `${Math.round(tRef)} BPM`,
      achieved: `${Math.round(tGen)} BPM`,
      score: tempoScore,
      detail: best < 0.06 ? "on target" : `${Math.round(best * 100)}% off`,
    });
  }

  // Key — exact = 100, right tonic OR right mode = 55, else 0.
  const kRef = parseKey(ref.features.key);
  const kGen = parseKey(gen.features.key);
  if (kRef && kGen) {
    let keyScore = 0;
    if (kRef.tonic === kGen.tonic && kRef.mode === kGen.mode) keyScore = 100;
    else if (kRef.tonic === kGen.tonic || kRef.mode === kGen.mode) keyScore = 55;
    dims.push({
      label: "Key",
      target: ref.features.key,
      achieved: gen.features.key,
      score: keyScore,
      detail: keyScore === 100 ? "match" : keyScore ? "partial" : "different",
    });
  }

  // Brightness / texture (categorical) — bonus dimensions.
  for (const dim of ["brightness", "density"] as const) {
    const r = (ref.features as unknown as Record<string, unknown>)[dim] as string;
    const g = (gen.features as unknown as Record<string, unknown>)[dim] as string;
    if (r && g) {
      dims.push({
        label: dim === "brightness" ? "Brightness" : "Rhythmic density",
        target: r,
        achieved: g,
        score: r === g ? 100 : 40,
      });
    }
  }

  const clap = cosine(ref.embedding, gen.embedding);
  if (clap != null) {
    dims.push({
      label: "Sonic similarity (CLAP)",
      target: "1.00",
      achieved: clap.toFixed(2),
      score: Math.max(0, Math.round(clap * 100)),
      detail: "audio-embedding cosine",
    });
  }

  // Overall: weight CLAP heaviest (it's the holistic measure), then tempo/key.
  const weights: Record<string, number> = {
    "Sonic similarity (CLAP)": 3,
    Tempo: 2,
    Key: 2,
    Brightness: 1,
    "Rhythmic density": 1,
  };
  let wsum = 0, acc = 0;
  for (const d of dims) {
    const w = weights[d.label] ?? 1;
    acc += d.score * w;
    wsum += w;
  }
  const overall = wsum ? Math.round(acc / wsum) : 0;
  return { overall, dims, clap };
}
