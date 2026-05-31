import { NextRequest, NextResponse } from "next/server";
import { getStudioRecordingIds } from "@/lib/musicbrainz";
import { aggregateAudioProfile, AudioProfile } from "@/lib/acousticbrainz";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Building a profile means several rate-limited MusicBrainz calls + slow
// AcousticBrainz lookups (~15-25s total). Cache the result per artist so only
// the first viewer pays that cost; everyone after gets it instantly.
// Stored on globalThis so the cache survives Next.js dev hot-reloads (a plain
// module-level Map gets reset on every fast-refresh and never sticks).
const g = globalThis as unknown as {
  __audioProfileCache?: Map<string, AudioProfile>;
};
const cache: Map<string, AudioProfile> =
  g.__audioProfileCache ?? (g.__audioProfileCache = new Map());

/**
 * Best-effort audio-feature profile from AcousticBrainz (tempo, key, mood,
 * danceability), aggregated over the artist's official studio-album recordings —
 * which is what makes the numbers representative (those tracks have ~100%
 * AcousticBrainz coverage, vs ~2% for a blind recording browse). Returns
 * { audioProfile: null } when nothing is found in time; the UI omits the stats.
 * Keyless and Neo4j-free.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ mbid: string }> }
) {
  const { mbid } = await params;
  try {
    if (cache.has(mbid)) {
      return NextResponse.json({ audioProfile: cache.get(mbid) });
    }
    const recordingIds = await getStudioRecordingIds(mbid);
    const audioProfile = await aggregateAudioProfile(recordingIds, 120);
    // Only cache a *complete* profile — one where the slow low-level docs came
    // through so we have the headline BPM. Otherwise let it recompute next load
    // instead of locking in dashes for tempo/key.
    if (audioProfile && audioProfile.avgBpm != null) cache.set(mbid, audioProfile);
    return NextResponse.json({ audioProfile });
  } catch {
    // Never surface AcousticBrainz/MusicBrainz flakiness as a page error.
    return NextResponse.json({ audioProfile: null });
  }
}
