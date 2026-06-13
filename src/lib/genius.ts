// Genius: accurate song metadata (writers, producers, release, art) via the API,
// plus a best-effort fetch of the lyric text. The API deliberately does NOT
// return lyrics (licensing), so the text comes from the public song page — used
// here only to let the LLM surface a couple of "notable lines". Degrades to
// metadata-only (and the Whisper transcript) if the token is missing or the page
// shape changes.

import { parse } from "node-html-parser";

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

/**
 * Best-effort scrape of the FULL lyric text from a Genius song page. Uses a real
 * HTML parser (the lyrics live in nested <div data-lyrics-container> blocks that
 * regex truncates), converts <br> to newlines, and strips Genius's leading
 * "contributors / translations / description … Read More" preamble.
 */
// A realistic browser UA — Genius is more likely to serve the cheap JS-shell
// variant (no lyrics) to non-browser UAs and datacenter IPs.
const LYRICS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function getLyrics(url: string): Promise<string | null> {
  // Genius intermittently serves a JS-shell page (no [data-lyrics-container],
  // no lyric text), especially on a cold edge hit or from Cloud Run's IPs. A
  // retry almost always gets the fully server-rendered page, so attempt a few
  // times before giving up — otherwise the karaoke silently falls back to raw
  // Whisper mishears (the "Blinding Lights" bug).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": LYRICS_UA,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      const root = parse(await res.text());
      const containers = root.querySelectorAll('[data-lyrics-container="true"]');
      if (containers.length === 0) {
        await new Promise((r) => setTimeout(r, 400));
        continue; // shell variant — retry for the SSR page
      }

      let text = containers
        .map((c) => {
          c.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
          return c.text;
        })
        .join("\n");

      // The lyrics proper begin at the first section tag ([Verse]/[Chorus]/…);
      // everything before it is Genius's header/description preamble.
      const section = text.match(
        /\[(Verse|Chorus|Intro|Outro|Bridge|Pre-?Chorus|Post-?Chorus|Hook|Refrain|Interlude|Instrumental|Breakdown)\b/i
      );
      if (section && section.index !== undefined) {
        text = text.slice(section.index);
      } else {
        text = text.replace(/^[\s\S]*?\bLyrics\b\s*/, "");
      }
      text = text.replace(/\n{3,}/g, "\n\n").trim();
      if (text.length > 20) return text;
      await new Promise((r) => setTimeout(r, 400));
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return null;
}

/**
 * Fetch full lyric text reliably from a server/datacenter IP. Genius serves a
 * JS-shell page (no lyrics) to datacenter IPs like Cloud Run's, so the page
 * scrape silently fails there. We try lrclib.net first — a plain JSON lyrics
 * API built for karaoke apps, no scraping or IP blocking — and only fall back
 * to the Genius scrape if lrclib has nothing.
 */
export async function getLyricsText(
  artist: string,
  title: string,
  geniusUrl?: string
): Promise<string | null> {
  const fromLrc = await getLrclibLyrics(artist, title);
  if (fromLrc) return fromLrc;
  return geniusUrl ? await getLyrics(geniusUrl) : null;
}

async function getLrclibLyrics(
  artist: string,
  title: string
): Promise<string | null> {
  const base = "https://lrclib.net/api";
  const headers = {
    "User-Agent": "MusicGenomeProject (music-intelligence demo)",
  };
  const enc = encodeURIComponent;
  try {
    // Exact match first — cheapest and most accurate.
    const get = await fetch(
      `${base}/get?artist_name=${enc(artist)}&track_name=${enc(title)}`,
      { headers }
    );
    if (get.ok) {
      const d = (await get.json()) as { plainLyrics?: string };
      const pl = (d.plainLyrics || "").trim();
      if (pl.length > 20) return pl;
    }
    // Fuzzy fallback — handles "(feat. …)" / remaster suffixes in iTunes titles.
    const search = await fetch(
      `${base}/search?artist_name=${enc(artist)}&track_name=${enc(title)}`,
      { headers }
    );
    if (search.ok) {
      const arr = (await search.json()) as { plainLyrics?: string }[];
      const hit = Array.isArray(arr)
        ? arr.find((x) => (x.plainLyrics || "").trim().length > 20)
        : null;
      if (hit) return (hit.plainLyrics as string).trim();
    }
  } catch {
    /* ignore — fall back to Genius */
  }
  return null;
}
