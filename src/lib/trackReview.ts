import { complete, bestSynthesisLlm } from "@/lib/llm";
import { SongMeta } from "@/lib/genius";

// Shared between the X-ray route (sync, warm GPU) and the async Flamingo backfill
// (cold GPU) so the 30s-clip review is generated identically in both — the only
// difference is whether Flamingo's read is present in the facts.

export interface TrackFeatures {
  tempo_bpm: number;
  tempo_feel: string;
  key: string;
  key_confidence: number;
  harmonic_emphasis: string[];
  brightness: string;
  texture: string;
  density: string;
  dynamics: string;
  energy_arc: number[];
  energy_shape: string;
}

export interface TagItem {
  label: string;
  prob: number;
}
export interface TagSet {
  instruments?: TagItem[];
  genres?: TagItem[];
  moods?: TagItem[];
  voice?: { vocal: boolean; prob: number };
}

const SYSTEM = `You are a music journalist — a sharp, evocative writer for a publication
like Pitchfork, Rolling Stone, or a respected music blog — writing a vivid, descriptive
review of a 30-second clip. DESCRIBE the music and bring it to life for a reader who
hasn't heard it: the instrumentation and how the parts interlock, the vocal, the
production and sense of space, the harmony, the structure, the mood and craft. You paint
a picture — you do NOT give the artist advice or suggest changes.

You're given several sources. Trust them like a working musician would:
- AI LISTENER (Music Flamingo) — a strong audio model's DETAILED read of THIS exact
  recording: instruments and how they interlock, the vocal and its treatment, production,
  key, chords, structure, mood. This is your PRIMARY source for what the music actually
  sounds like. LEAN ON ITS SPECIFICS — match its level of detail; do not flatten its rich
  read into vague generalities.
- DETECTED (discriminative tagger) — supervised classifiers; the MOST RELIABLE word on
  WHICH instruments are present and WHETHER THERE ARE VOCALS. If Flamingo names an
  instrument the tagger doesn't list (or omits one it does), defer to the tagger for
  presence, and use Flamingo for how it's played.
- MEASURED (librosa DSP) — a rough cross-check only. Its tempo is OFTEN AN OCTAVE OFF
  (double/half-time), and its key/chords are weak chroma estimates. Do not treat it as
  ground truth.
- LYRICS (Genius) — the real words.

Reconcile like a musician:
- Key & chords: prefer Flamingo's.
- Instruments & vocals present: trust DETECTED; describe their interplay with Flamingo.
- TEMPO: state ONE coherent tempo. If MEASURED's BPM is roughly double or half Flamingo's
  stated tempo, that's a measurement artifact — use the perceived pulse (usually the
  slower number that matches the groove you're describing). NEVER cite a BPM that
  contradicts the feel, and never write "feels like half-time" hedges.
- NEVER name the tools in the prose ("librosa", "the tagger", "Flamingo says") — write
  naturally, as if you simply heard the song.

Rules:
- It's a 30-second clip — describe "this section," in present tense.
- Be as SPECIFIC and richly detailed as the source material: name the instruments and how
  they lock together, the vocal character and processing, the production and spatial
  sense, the harmonic movement, the structure across the clip, the mood it conjures.
  Vivid, flowing prose — no bullet points, no section headers, no advice, no hedging, no
  preamble.
- Ground every claim in the sources; never invent.
- Output EXACTLY this shape, nothing else:
REVIEW: <200-300 words, third person, a descriptive narrative review of this section>
NOTABLE: <2-3 striking lyric lines, copied VERBATIM from the provided lyrics, separated by " || ">
If no lyrics are provided, write "NOTABLE: NONE".`;

export type LyricsSource = "genius" | "whisper" | "none";

export function tagFacts(tags?: TagSet | null): string {
  if (!tags || (!tags.instruments?.length && !tags.voice && !tags.genres?.length))
    return "";
  const fmt = (xs?: TagItem[]) =>
    (xs || []).map((t) => `${t.label} (${t.prob})`).join(", ");
  const lines = [
    "DETECTED (discriminative tagger — most reliable for what's present):",
    tags.voice
      ? `- Vocals: ${tags.voice.vocal ? `yes (confidence ${tags.voice.prob})` : `no — instrumental (confidence ${tags.voice.prob})`}`
      : "",
    tags.instruments?.length ? `- Instruments present: ${fmt(tags.instruments)}` : "",
    tags.genres?.length ? `- Genres: ${fmt(tags.genres)}` : "",
    tags.moods?.length ? `- Moods: ${fmt(tags.moods)}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

export async function generateTrackReview(opts: {
  features: TrackFeatures | null;
  meta: SongMeta | null;
  flamingo: string;
  tags?: TagSet | null;
  lyricsForLlm: string;
  lyricsSource: LyricsSource;
  title: string;
  artist: string;
}): Promise<{ breakdown: string; notableLyrics: string[]; model: string }> {
  const { features, meta, flamingo, tags, lyricsForLlm, lyricsSource, title, artist } =
    opts;

  const facts = [
    `Song: ${title} — ${artist}`,
    meta?.releaseDate ? `Released: ${meta.releaseDate}` : "",
    meta?.producers?.length ? `Producers: ${meta.producers.join(", ")}` : "",
    meta?.writers?.length ? `Writers: ${meta.writers.join(", ")}` : "",
    "",
    flamingo
      ? `AI LISTENER — Music Flamingo's detailed read of this recording (your PRIMARY source — lean on its specifics):\n${flamingo.slice(0, 5000)}`
      : "",
    "",
    tagFacts(tags),
    "",
    "MEASURED (librosa DSP — rough cross-check only; tempo may be octave-off, key/chords weak):",
    features
      ? [
          `- Tempo: ${features.tempo_bpm} BPM (${features.tempo_feel})`,
          `- Key: ${features.key} (confidence ${features.key_confidence})`,
          `- Harmonic emphasis: ${features.harmonic_emphasis.join(", ")}`,
          `- Texture: ${features.texture}; Brightness: ${features.brightness}; Density: ${features.density}; Dynamics: ${features.dynamics}`,
          `- Energy across the clip: ${features.energy_shape}`,
        ].join("\n")
      : "- (audio analysis unavailable)",
    "",
    lyricsForLlm
      ? `Lyrics (${lyricsSource === "whisper" ? "rough auto-transcription, may be wrong" : "from Genius"}):\n${lyricsForLlm.slice(0, 1500)}`
      : "Lyrics: none available.",
  ]
    .filter(Boolean)
    .join("\n");

  const llm = bestSynthesisLlm();
  const raw = await complete(SYSTEM, facts, llm);

  const breakdown = (raw.split(/NOTABLE:/i)[0] || "")
    .replace(/^\s*(REVIEW|CRITIQUE|BREAKDOWN):/i, "")
    .trim();
  const notableRaw = (raw.split(/NOTABLE:/i)[1] || "").trim();
  const notableLyrics =
    notableRaw && !/^none/i.test(notableRaw)
      ? notableRaw.split("||").map((s) => s.trim()).filter(Boolean).slice(0, 3)
      : [];

  return { breakdown, notableLyrics, model: llm.model || "ollama" };
}
