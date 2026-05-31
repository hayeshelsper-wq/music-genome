// Last.fm: "similar artists" (undirected sonic adjacency) + top tags.
// Free instant key at https://www.last.fm/api/account/create

const BASE = "https://ws.audioscrobbler.com/2.0/";

interface LastfmSimilar {
  similarartists?: {
    artist?: Array<{ name: string; match: string; mbid?: string }>;
  };
}
interface LastfmTags {
  toptags?: { tag?: Array<{ name: string; count: number }> };
}

async function lfm<T>(params: Record<string, string>): Promise<T | null> {
  const key = process.env.LASTFM_API_KEY;
  if (!key) return null; // gracefully degrade — the app still works without it
  const qs = new URLSearchParams({
    ...params,
    api_key: key,
    format: "json",
  }).toString();
  const res = await fetch(`${BASE}?${qs}`);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export async function similarArtists(
  name: string
): Promise<{ name: string; mbid?: string; match: number }[]> {
  const data = await lfm<LastfmSimilar>({
    method: "artist.getsimilar",
    artist: name,
    limit: "12",
    autocorrect: "1",
  });
  return (data?.similarartists?.artist || []).map((a) => ({
    name: a.name,
    mbid: a.mbid || undefined,
    match: parseFloat(a.match) || 0,
  }));
}

export async function topTags(name: string): Promise<string[]> {
  const data = await lfm<LastfmTags>({
    method: "artist.gettoptags",
    artist: name,
    autocorrect: "1",
  });
  return (data?.toptags?.tag || [])
    .filter((t) => t.count >= 10)
    .slice(0, 12)
    .map((t) => t.name);
}
