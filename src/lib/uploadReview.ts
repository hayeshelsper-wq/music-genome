import { complete, bestSynthesisLlm } from "@/lib/llm";
import { TagSet, tagFacts } from "@/lib/trackReview";

// Shared between the upload route (sync, warm GPU) and the async flamingo
// backfill (cold GPU) so the review is generated identically in both — the only
// difference is whether Flamingo's read is present in the facts.

const SYSTEM = `You are a music journalist writing a vivid, descriptive review of a full
track for a publication like Pitchfork or Rolling Stone. DESCRIBE the music and bring it
to life for a reader who hasn't heard it: the instrumentation and how the parts interlock,
the vocal, the production and sense of space, the harmony, the mood, and how it moves
across its sections. You paint a picture — you do NOT give the artist advice or suggest
changes.

You're given several sources. Trust them like a working musician would:
- AI LISTENER (Music Flamingo) — a strong audio model's DETAILED read of this recording:
  instruments and how they interlock, the vocal and its treatment, production, key,
  chords, structure, mood. This is your PRIMARY source for what the music sounds like.
  LEAN ON ITS SPECIFICS — match its level of detail; do not flatten it into generalities.
- DETECTED (discriminative tagger) — supervised classifiers; the MOST RELIABLE word on
  WHICH instruments are present and WHETHER THERE ARE VOCALS. Defer to it for presence;
  use Flamingo for how things are played.
- MEASURED (librosa DSP) — a rough cross-check. Trust its energy arc / structure, but its
  tempo is OFTEN AN OCTAVE OFF (double/half-time) and its key/chords are weak estimates.

Reconcile like a musician:
- Key & chords: prefer Flamingo's.
- Instruments & vocals present: trust DETECTED; describe interplay with Flamingo.
- TEMPO: state ONE coherent tempo. If MEASURED's BPM is roughly double or half Flamingo's,
  it's a measurement artifact — use the perceived pulse that matches the groove. NEVER
  cite a BPM that contradicts the feel, and never write "feels like half-time" hedges.
- NEVER name the tools in the prose ("librosa", "the tagger", "Flamingo") — write naturally.

Rules:
- 200-300 words, third person, present tense, flowing narrative prose. Be as SPECIFIC and
  richly detailed as the sources: name instruments and how they lock together, the vocal
  character and processing, the production/space, the harmonic movement, and how the
  arrangement evolves across its sections. No bullet points, no preamble, no advice.
- Output ONLY the review prose.`;

interface Section {
  start: number;
  end: number;
  intensity: number;
  label: string;
}
interface UF {
  duration_sec?: number;
  tempo_bpm?: number;
  tempo_feel?: string;
  key?: string;
  key_confidence?: number;
  harmonic_emphasis?: string[];
  chords?: string[];
  progression?: string | null;
  brightness?: string;
  texture?: string;
  density?: string;
  dynamics?: string;
  energy_shape?: string;
}

export async function generateUploadReview(
  features: UF,
  sections: Section[],
  flamingo: string,
  title: string,
  artist = "",
  tags?: TagSet | null
): Promise<{ breakdown: string; model: string }> {
  const f = features || {};
  const facts = [
    `Track: ${title}${artist ? ` — ${artist}` : ""}`,
    "",
    flamingo
      ? `AI LISTENER — Music Flamingo's detailed read of a representative section (your PRIMARY source — lean on its specifics):\n${String(flamingo).slice(0, 5000)}`
      : "",
    "",
    tagFacts(tags),
    "",
    "MEASURED (librosa DSP — trust energy/structure; tempo may be octave-off, key/chords weak):",
    `- Duration: ${f.duration_sec}s`,
    `- Tempo: ${f.tempo_bpm} BPM (${f.tempo_feel})`,
    `- Key: ${f.key} (confidence ${f.key_confidence})`,
    f.chords?.length
      ? `- Chords: ${f.chords.join(" ")}${f.progression ? ` (${f.progression})` : ""}`
      : "",
    `- Harmonic emphasis: ${(f.harmonic_emphasis || []).join(", ")}`,
    `- Texture: ${f.texture}; Brightness: ${f.brightness}; Density: ${f.density}; Dynamics: ${f.dynamics}`,
    `- Energy arc: ${f.energy_shape}`,
    sections?.length
      ? `- Structure: ${sections.map((s) => `${s.label} (${s.start}-${s.end}s)`).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const llm = bestSynthesisLlm();
    const breakdown = (await complete(SYSTEM, facts, llm))
      .trim()
      .replace(/^\s*(REVIEW|CRITIQUE):/i, "")
      .trim();
    return { breakdown, model: llm.model ?? "" };
  } catch {
    return { breakdown: "", model: "" };
  }
}
