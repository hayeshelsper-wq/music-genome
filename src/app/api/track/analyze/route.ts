import { NextRequest, NextResponse } from "next/server";
import { getSongMeta, getLyrics, SongMeta } from "@/lib/genius";
import { complete, bestSynthesisLlm } from "@/lib/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

interface Features {
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
interface AudioResult {
  features: Features | null;
  lyrics: { text: string; lines: string[] };
  chromagram: string | null;
  error?: string;
}
interface TrackAnalysis {
  features: Features | null;
  chromagram: string | null;
  whisper: { text: string };
  genius: SongMeta | null;
  flamingo: string;
  fullLyrics: string;
  notableLyrics: string[];
  lyricsSource: "genius" | "whisper" | "none";
  breakdown: string;
  model: string;
}

// Synthesis is the expensive bit; cache per preview (survives dev hot-reload).
const g = globalThis as unknown as { __trackCache?: Map<string, TrackAnalysis> };
const cache: Map<string, TrackAnalysis> = g.__trackCache ?? (g.__trackCache = new Map());

const SYSTEM = `You are a multi-Grammy-winning songwriter and record producer — think
the person who has made career-defining records — giving a candid critique of a
30-second clip of a song. You speak with authority, taste, and specificity: you
hear arrangement choices, vocal production, harmonic moves, and mix decisions,
and you have opinions about what works and what you'd push further.

You're given three inputs, in descending order of trust:
1. MEASURED (librosa DSP) — ground truth for tempo and key. Trust these.
2. AI LISTENER (Music Flamingo) — a model's rich but fallible read of the audio
   (chords, instrumentation, structure). Treat as an informed second opinion;
   defer to MEASURED on tempo/key if they conflict.
3. METADATA / LYRICS (Genius) — real credits and words.

Rules:
- It's only a 30-second clip — critique "this section", not the whole song.
- Be specific and opinionated, like notes to an artist. No hedging, no preamble.
- Ground sonic claims; don't invent a tempo/key that contradicts MEASURED.
- Output EXACTLY this shape, nothing else:
CRITIQUE: <~130 words, first person, as the producer: what's working, the harmonic/arrangement/production choices that stand out, and one thing you'd push>
NOTABLE: <2-3 striking lyric lines, copied VERBATIM from the provided lyrics, separated by " || ">
If no lyrics are provided, write "NOTABLE: NONE".`;

async function callAudio(previewUrl: string, title: string, artist: string): Promise<AudioResult> {
  const res = await fetch(`${AUDIO_SERVICE}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ previewUrl, title, artist }),
  });
  if (!res.ok) throw new Error(`audio-service ${res.status}`);
  return (await res.json()) as AudioResult;
}

async function callFlamingo(previewUrl: string): Promise<string> {
  try {
    const res = await fetch(`${AUDIO_SERVICE}/flamingo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previewUrl }),
    });
    if (!res.ok) return "";
    const json = (await res.json()) as { description?: string };
    return json.description || "";
  } catch {
    return ""; // best-effort — the critique still runs on librosa + Genius
  }
}

export async function GET(req: NextRequest) {
  const previewUrl = req.nextUrl.searchParams.get("previewUrl");
  const title = req.nextUrl.searchParams.get("title") || "";
  const artist = req.nextUrl.searchParams.get("artist") || "";
  if (!previewUrl) return NextResponse.json({ error: "previewUrl required" }, { status: 400 });

  if (cache.has(previewUrl)) return NextResponse.json(cache.get(previewUrl));

  try {
    // librosa analysis + Music Flamingo + Genius metadata all run concurrently
    const [audio, flamingo, meta] = await Promise.all([
      callAudio(previewUrl, title, artist),
      callFlamingo(previewUrl),
      getSongMeta(artist, title).catch(() => null),
    ]);
    const lyrics = meta?.url ? await getLyrics(meta.url).catch(() => null) : null;

    const features = audio.features;
    const lyricsForLlm = lyrics || audio.lyrics?.text || "";
    const lyricsSource: TrackAnalysis["lyricsSource"] = lyrics
      ? "genius"
      : audio.lyrics?.text
        ? "whisper"
        : "none";

    const facts = [
      `Song: ${title} — ${artist}`,
      meta?.releaseDate ? `Released: ${meta.releaseDate}` : "",
      meta?.producers?.length ? `Producers: ${meta.producers.join(", ")}` : "",
      meta?.writers?.length ? `Writers: ${meta.writers.join(", ")}` : "",
      "",
      "Measurements (30s preview):",
      features
        ? [
            `- Tempo: ${features.tempo_bpm} BPM (${features.tempo_feel})`,
            `- Key: ${features.key} (confidence ${features.key_confidence})`,
            `- Harmonic emphasis: ${features.harmonic_emphasis.join(", ")}`,
            `- Texture: ${features.texture}`,
            `- Brightness: ${features.brightness}`,
            `- Rhythmic density: ${features.density}`,
            `- Dynamics: ${features.dynamics}`,
            `- Energy across the clip: ${features.energy_shape}`,
          ].join("\n")
        : "- (audio analysis unavailable)",
      "",
      flamingo
        ? `AI LISTENER — Music Flamingo's read of the audio (informed but fallible):\n${flamingo.slice(0, 2500)}`
        : "",
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
      .replace(/^\s*(CRITIQUE|BREAKDOWN):/i, "")
      .trim();
    const notableRaw = (raw.split(/NOTABLE:/i)[1] || "").trim();
    const notableLyrics =
      notableRaw && !/^none/i.test(notableRaw)
        ? notableRaw.split("||").map((s) => s.trim()).filter(Boolean).slice(0, 3)
        : [];

    const result: TrackAnalysis = {
      features,
      chromagram: audio.chromagram,
      whisper: { text: audio.lyrics?.text || "" },
      genius: meta,
      flamingo,
      fullLyrics: lyrics || "", // accurate full lyrics from Genius (whole song)
      notableLyrics,
      lyricsSource: notableLyrics.length ? lyricsSource : "none",
      breakdown,
      model: llm.model || "ollama",
    };
    if (features) cache.set(previewUrl, result);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "analysis failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
