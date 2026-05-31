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
  notableLyrics: string[];
  lyricsSource: "genius" | "whisper" | "none";
  breakdown: string;
  model: string;
}

// Synthesis is the expensive bit; cache per preview (survives dev hot-reload).
const g = globalThis as unknown as { __trackCache?: Map<string, TrackAnalysis> };
const cache: Map<string, TrackAnalysis> = g.__trackCache ?? (g.__trackCache = new Map());

const SYSTEM = `You are a record producer and music critic analyzing ONE song.
You are given DSP measurements of a 30-second preview (already interpreted into
plain labels), plus song metadata and, when available, the lyric text. Write a
sharp, specific read that a producer would nod at.
Rules:
- Ground every sonic claim in the supplied measurements. Never invent tempo/key.
- Remember it's only a 30s clip, so speak to "this section" for arrangement.
- Output EXACTLY this shape, nothing else:
BREAKDOWN: <~110 words: tonal character, rhythmic feel, arrangement & dynamics>
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

export async function GET(req: NextRequest) {
  const previewUrl = req.nextUrl.searchParams.get("previewUrl");
  const title = req.nextUrl.searchParams.get("title") || "";
  const artist = req.nextUrl.searchParams.get("artist") || "";
  if (!previewUrl) return NextResponse.json({ error: "previewUrl required" }, { status: 400 });

  if (cache.has(previewUrl)) return NextResponse.json(cache.get(previewUrl));

  try {
    // audio analysis + Genius metadata run concurrently
    const [audio, meta] = await Promise.all([
      callAudio(previewUrl, title, artist),
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
      lyricsForLlm
        ? `Lyrics (${lyricsSource === "whisper" ? "rough auto-transcription, may be wrong" : "from Genius"}):\n${lyricsForLlm.slice(0, 1500)}`
        : "Lyrics: none available.",
    ]
      .filter(Boolean)
      .join("\n");

    const llm = bestSynthesisLlm();
    const raw = await complete(SYSTEM, facts, llm);

    const breakdown = (raw.split(/NOTABLE:/i)[0] || "")
      .replace(/^BREAKDOWN:/i, "")
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
