// Genius: accurate song metadata (writers, producers, release, art) via the API,
// plus a best-effort fetch of the lyric text. The API deliberately does NOT
// return lyrics (licensing), so the text comes from the public song page — used
// here only to let the LLM surface a couple of "notable lines". Degrades to
// metadata-only (and the Whisper transcript) if the token is missing or the page
// shape changes.

const API = "https://api.genius.com";

export interface SongMeta {
  title: string;
  artist: string;
  fullTitle: string;
  url: string;
  releaseDate?: string;
  producers: string[];
  writers: string[];
  pageviews?: number;
  artworkUrl?: string;
}

interface GeniusSong {
  full_title: string;
  title: string;
  url: string;
  release_date_for_display?: string;
  song_art_image_thumbnail_url?: string;
  primary_artist?: { name: string };
  producer_artists?: { name: string }[];
  writer_artists?: { name: string }[];
  stats?: { pageviews?: number };
}

async function api<T>(path: string): Promise<T | null> {
  const token = process.env.GENIUS_ACCESS_TOKEN;
  if (!token) return null;
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export async function getSongMeta(
  artist: string,
  title: string
): Promise<SongMeta | null> {
  const search = await api<{ response: { hits: { result: { id: number; primary_artist?: { name: string } } }[] } }>(
    `/search?q=${encodeURIComponent(`${artist} ${title}`)}`
  );
  const hit = search?.response?.hits?.find(
    (h) =>
      h.result.primary_artist?.name?.toLowerCase().includes(artist.toLowerCase()) ??
      true
  );
  const id = hit?.result?.id;
  if (!id) return null;

  const detail = await api<{ response: { song: GeniusSong } }>(`/songs/${id}`);
  const s = detail?.response?.song;
  if (!s) return null;
  return {
    title: s.title,
    artist: s.primary_artist?.name ?? artist,
    fullTitle: s.full_title,
    url: s.url,
    releaseDate: s.release_date_for_display,
    producers: (s.producer_artists ?? []).map((a) => a.name),
    writers: (s.writer_artists ?? []).map((a) => a.name),
    pageviews: s.stats?.pageviews,
    artworkUrl: s.song_art_image_thumbnail_url,
  };
}

/** Best-effort scrape of the lyric text from a Genius song page. */
export async function getLyrics(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (MusicGenomeProject)" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Lyrics live in one or more <div data-lyrics-container="true"> ... </div>.
    const blocks = [...html.matchAll(/data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g)];
    if (blocks.length === 0) return null;
    const text = blocks
      .map((m) => m[1])
      .join("\n")
      .replace(/<br\s*\/?>(?=)/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text.length > 20 ? text : null;
  } catch {
    return null;
  }
}
