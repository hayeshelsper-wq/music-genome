import { NextRequest, NextResponse } from "next/server";
import { lookupIsrc } from "@/lib/musicbrainz";
import { getTrackPreview } from "@/lib/itunes";
import { getSongMeta } from "@/lib/genius";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The "light card" for one playlist track: resolve the ISRC->MBID bridge, grab a
// playable iTunes preview + artwork, and pull Genius credits. All three run
// concurrently and each degrades to null, so a card always renders something.
// Heavy analysis (librosa X-ray, stems, LLM critique) is loaded on demand by the
// SongXray component when the user expands the card — this stays cheap.
interface TrackCard {
  isrc?: string;
  recordingMbid?: string;
  artistMbid?: string;
  artistName?: string;
  preview?: {
    previewUrl?: string;
    artworkUrl?: string;
    album?: string;
    releaseYear?: number;
  } | null;
  credits?: {
    producers: string[];
    writers: string[];
    releaseDate?: string;
    url?: string;
    pageviews?: number;
  } | null;
}

const g = globalThis as unknown as { __trackCardCache?: Map<string, TrackCard> };
const cache: Map<string, TrackCard> =
  g.__trackCardCache ?? (g.__trackCardCache = new Map());

export async function GET(req: NextRequest) {
  const isrc = req.nextUrl.searchParams.get("isrc") || undefined;
  const artist = req.nextUrl.searchParams.get("artist") || "";
  const title = req.nextUrl.searchParams.get("title") || "";
  if (!artist || !title) {
    return NextResponse.json(
      { error: "artist & title required" },
      { status: 400 }
    );
  }

  const cacheKey = isrc || `${artist}::${title}`;
  const cached = cache.get(cacheKey);
  if (cached) return NextResponse.json(cached);

  const [bridge, preview, credits] = await Promise.all([
    isrc ? lookupIsrc(isrc).catch(() => null) : Promise.resolve(null),
    getTrackPreview(artist, title).catch(() => null),
    getSongMeta(artist, title).catch(() => null),
  ]);

  const card: TrackCard = {
    isrc,
    recordingMbid: bridge?.recordingMbid,
    artistMbid: bridge?.artistMbid,
    artistName: bridge?.artistName || artist,
    preview: preview
      ? {
          previewUrl: preview.previewUrl,
          artworkUrl: preview.artworkUrl,
          album: preview.album,
          releaseYear: preview.releaseYear,
        }
      : null,
    credits: credits
      ? {
          producers: credits.producers,
          writers: credits.writers,
          releaseDate: credits.releaseDate,
          url: credits.url,
          pageviews: credits.pageviews,
        }
      : null,
  };
  cache.set(cacheKey, card);
  return NextResponse.json(card);
}
