// iTunes Search API — free, no auth, no signup. Gives us 30-second preview
// streams and album artwork, which Spotify removed for new apps in Nov 2024.
// This is what makes the report *audible* and *visual* instead of pure text.
// Rate limit is ~20 req/min, which is plenty for one artist page.

const BASE = "https://itunes.apple.com/search";

export interface TopTrack {
  title: string;
  album?: string;
  artworkUrl?: string; // upgraded to 300x300
  previewUrl?: string; // 30s m4a stream
  trackTimeMs?: number;
  releaseYear?: number;
  genre?: string;
}

interface ItunesResult {
  resultCount: number;
  results: Array<{
    wrapperType?: string;
    kind?: string;
    artistName?: string;
    trackName?: string;
    collectionName?: string;
    artworkUrl100?: string;
    previewUrl?: string;
    trackTimeMillis?: number;
    releaseDate?: string;
    primaryGenreName?: string;
  }>;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Best-effort "top tracks" for an artist: iTunes relevance order, filtered to
 * the matching artist and to songs that actually have a playable preview, then
 * deduped by title. Artwork is bumped from the default 100px to 300px.
 */
export async function getTopTracks(
  artistName: string,
  limit = 12
): Promise<TopTrack[]> {
  const qs = new URLSearchParams({
    term: artistName,
    entity: "song",
    attribute: "artistTerm",
    limit: "60",
  }).toString();

  let data: ItunesResult;
  try {
    const res = await fetch(`${BASE}?${qs}`);
    if (!res.ok) return [];
    data = (await res.json()) as ItunesResult;
  } catch {
    return [];
  }

  const target = norm(artistName);
  const seen = new Set<string>();
  const out: TopTrack[] = [];

  for (const r of data.results || []) {
    if (r.kind !== "song" || !r.trackName) continue;
    // Keep only tracks credited to (or featuring) the artist we asked for.
    const credited = norm(r.artistName || "");
    if (!credited.includes(target) && !target.includes(credited)) continue;
    if (!r.previewUrl) continue; // a preview is the whole point
    const key = norm(r.trackName);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: r.trackName,
      album: r.collectionName,
      artworkUrl: r.artworkUrl100?.replace("100x100", "300x300"),
      previewUrl: r.previewUrl,
      trackTimeMs: r.trackTimeMillis,
      releaseYear: r.releaseDate
        ? parseInt(r.releaseDate.slice(0, 4), 10) || undefined
        : undefined,
      genre: r.primaryGenreName,
    });
    if (out.length >= limit) break;
  }
  return out;
}
