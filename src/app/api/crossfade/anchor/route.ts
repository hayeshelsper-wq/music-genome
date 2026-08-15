// Style anchor for one crossfader side: terse style tags from the artist's
// cached sonic fingerprint + (best-effort) a 10s center cut of their
// representative preview for audio conditioning.

import { NextRequest, NextResponse } from "next/server";
import { computeArtistSonic } from "@/lib/trail";
import { styleTagsFromSonic } from "@/lib/studioPrompt";
import { cloudRunAuthHeader } from "@/lib/cloudRun";
import { getReport } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

export async function GET(req: NextRequest) {
  const mbid = req.nextUrl.searchParams.get("mbid") || "";
  const name = req.nextUrl.searchParams.get("name") || "";
  if (!mbid || !name) {
    return NextResponse.json({ error: "mbid and name required" }, { status: 400 });
  }
  try {
    const sonic = await computeArtistSonic(mbid, name);
    // Genre/mood words steer MusicCoCa far better than DSP stats alone — the
    // artist report already carries Last.fm tags ("psychedelic rock", "glam
    // rock"), so lead with those; without them the generator drifts to
    // generic rhythm beds.
    const report = await getReport(mbid).catch(() => null);
    const genreTags = (report?.tags || []).slice(0, 5).join(", ");
    const text = [genreTags, styleTagsFromSonic(sonic)].filter(Boolean).join(", ");

    let audio_b64: string | null = null;
    const preview = sonic.tracks.find((t) => t.previewUrl)?.previewUrl;
    if (preview) {
      try {
        const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
        const res = await fetch(`${AUDIO_SERVICE}/clip`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth },
          body: JSON.stringify({ previewUrl: preview, seconds: 10 }),
          signal: AbortSignal.timeout(30_000),
        });
        const j = (await res.json()) as { wav_b64?: string; error?: string };
        if (res.ok && j.wav_b64) audio_b64 = j.wav_b64;
      } catch {
        audio_b64 = null; // text-only anchor still works
      }
    }
    return NextResponse.json({ text, audio_b64 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "anchor failed" },
      { status: 502 }
    );
  }
}
