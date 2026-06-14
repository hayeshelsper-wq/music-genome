import { NextRequest, NextResponse } from "next/server";
import { getSongMeta, getLyricsText } from "@/lib/genius";
import { generateTrackReview } from "@/lib/trackReview";
import { callAudio, callFlamingo } from "@/lib/trackAudio";
import { saveXray } from "@/lib/store";

// Async Flamingo backfill for the X-ray. When the first paint hit a COLD GPU, the
// client polls this; the first call warms the GPU (long timeout + audio-service
// retry-on-503), a follow-up lands the read. Once Flamingo arrives we regenerate
// the review with it folded in and return the upgraded result.
export const dynamic = "force-dynamic";
export const maxDuration = 360;

export async function GET(req: NextRequest) {
  const previewUrl = req.nextUrl.searchParams.get("previewUrl");
  const title = req.nextUrl.searchParams.get("title") || "";
  const artist = req.nextUrl.searchParams.get("artist") || "";
  if (!previewUrl)
    return NextResponse.json({ error: "previewUrl required" }, { status: 400 });

  // Warm-gated: a fast (~6s) is_warm probe that ALSO nudges the cold GPU awake
  // (the probe hits the Flamingo container's /health, triggering scale-from-zero
  // + image pull). If still cold, return immediately so the client polls again —
  // we never block the whole request waiting on a ~5-7min image pull. Only once
  // the GPU is warm does this run the (now-fast ~60-90s) describe.
  const flamingoRes = await callFlamingo(previewUrl, {
    requireWarm: true,
    timeoutMs: 160_000,
    flamingoTimeoutSec: 150,
  });
  const flamingo = flamingoRes.text;

  if (!flamingo) {
    // Still cold / warming (or a transient miss) — tell the client to keep polling.
    return NextResponse.json({
      flamingo: "",
      flamingoStatus: "pending",
      flamingoError: flamingoRes.error,
    });
  }

  // Flamingo landed — rebuild the same facts and regenerate the review with it.
  const [audio, meta] = await Promise.all([
    callAudio(previewUrl, title, artist).catch(() => null),
    getSongMeta(artist, title).catch(() => null),
  ]);
  const lyrics = await getLyricsText(artist, title, meta?.url).catch(() => null);
  const lyricsForLlm = lyrics || audio?.lyrics?.text || "";
  const lyricsSource = lyrics ? "genius" : audio?.lyrics?.text ? "whisper" : "none";

  const { breakdown, notableLyrics, model } = await generateTrackReview({
    features: audio?.features ?? null,
    meta,
    flamingo,
    tags: audio?.tags ?? null,
    lyricsForLlm,
    lyricsSource,
    title,
    artist,
  });

  // Persist the now-complete X-Ray so future views are instant (no GPU).
  if (audio?.features) {
    const full = {
      features: audio.features,
      chromagram: audio.chromagram ?? null,
      whisper: { text: audio.lyrics?.text || "" },
      genius: meta,
      flamingo,
      flamingoStatus: "complete",
      tags: audio.tags ?? null,
      fullLyrics: lyrics || "",
      notableLyrics,
      lyricsSource: notableLyrics.length ? lyricsSource : "none",
      breakdown,
      model,
    };
    saveXray(artist, title, full, { previewUrl, artwork: meta?.artworkUrl }).catch(() => {});
  }

  return NextResponse.json({
    flamingo,
    flamingoStatus: "complete",
    breakdown,
    notableLyrics,
    model,
    tags: audio?.tags ?? null,
  });
}
