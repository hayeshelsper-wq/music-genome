import { NextRequest, NextResponse } from "next/server";
import { getSongMeta, getLyricsText, SongMeta } from "@/lib/genius";
import { generateTrackReview, TrackFeatures, TagSet } from "@/lib/trackReview";
import { callAudio, callFlamingo } from "@/lib/trackAudio";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Features = TrackFeatures;
interface TrackAnalysis {
  features: Features | null;
  chromagram: string | null;
  whisper: { text: string };
  genius: SongMeta | null;
  flamingo: string;
  flamingoError?: string;
  flamingoStatus?: "complete" | "pending";
  tags?: TagSet | null;
  fullLyrics: string;
  notableLyrics: string[];
  lyricsSource: "genius" | "whisper" | "none";
  breakdown: string;
  model: string;
}

// Synthesis is the expensive bit; cache per preview (survives dev hot-reload).
const g = globalThis as unknown as { __trackCache?: Map<string, TrackAnalysis> };
const cache: Map<string, TrackAnalysis> = g.__trackCache ?? (g.__trackCache = new Map());

export async function GET(req: NextRequest) {
  const previewUrl = req.nextUrl.searchParams.get("previewUrl");
  const title = req.nextUrl.searchParams.get("title") || "";
  const artist = req.nextUrl.searchParams.get("artist") || "";
  if (!previewUrl) return NextResponse.json({ error: "previewUrl required" }, { status: 400 });

  if (cache.has(previewUrl)) return NextResponse.json(cache.get(previewUrl));

  try {
    // librosa analysis + Music Flamingo + Genius metadata all run concurrently.
    // Flamingo is warm-gated: a cold GPU returns instantly (cold=true) so the
    // X-ray paints right away and the client polls /api/track/flamingo to fill
    // it in — the review here is provisional and gets regenerated then.
    const [audio, flamingoRes, meta] = await Promise.all([
      callAudio(previewUrl, title, artist),
      callFlamingo(previewUrl, { requireWarm: true }),
      getSongMeta(artist, title).catch(() => null),
    ]);
    const flamingo = flamingoRes.text;
    const lyrics = await getLyricsText(artist, title, meta?.url).catch(
      () => null
    );

    const features = audio.features;
    const lyricsForLlm = lyrics || audio.lyrics?.text || "";
    const lyricsSource: TrackAnalysis["lyricsSource"] = lyrics
      ? "genius"
      : audio.lyrics?.text
        ? "whisper"
        : "none";

    const tags = audio.tags ?? null;
    const { breakdown, notableLyrics, model } = await generateTrackReview({
      features,
      meta,
      flamingo,
      tags,
      lyricsForLlm,
      lyricsSource,
      title,
      artist,
    });

    // Cold GPU → Flamingo still pending; the client will poll the backfill.
    const flamingoStatus: "complete" | "pending" = flamingoRes.cold
      ? "pending"
      : "complete";

    const result: TrackAnalysis = {
      features,
      chromagram: audio.chromagram,
      whisper: { text: audio.lyrics?.text || "" },
      genius: meta,
      flamingo,
      flamingoError: flamingo ? undefined : flamingoRes.error,
      flamingoStatus,
      tags,
      fullLyrics: lyrics || "", // accurate full lyrics from Genius (whole song)
      notableLyrics,
      lyricsSource: notableLyrics.length ? lyricsSource : "none",
      breakdown,
      model,
    };
    // Cache complete results. If Flamingo was cold/transiently missing, DON'T
    // cache — so the backfill (and later requests) retry once the GPU is warm.
    const flamingoSettled =
      !flamingoRes.cold && (!!flamingo || flamingoRes.error === "disabled");
    if (features && flamingoSettled) cache.set(previewUrl, result);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "analysis failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
