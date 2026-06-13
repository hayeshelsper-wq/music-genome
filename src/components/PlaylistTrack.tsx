"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import SongXray from "./SongXray";

export interface SpotifyTrack {
  id: string | null;
  title: string;
  artists: string[];
  album?: string;
  isrc?: string;
  durationMs?: number;
  image?: string;
}

export interface TrackCard {
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

function dur(ms?: number): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * One Spotify-style row of the playlist feed. Collapsed it's a tight track line
 * (index that flips to ▶ on hover, art, title/artist, album, duration); clicking
 * the row expands the inline "light card" + on-demand Deep X-ray. Audio is owned
 * by the page (so only one preview plays at a time and the hero Play button works)
 * — this component just reports its card up and calls onTogglePlay with its URL.
 */
export default function PlaylistTrack({
  track,
  index,
  preload,
  playingUrl,
  onTogglePlay,
  onCard,
}: {
  track: SpotifyTrack;
  index: number;
  preload: boolean;
  playingUrl: string | null;
  onTogglePlay: (url: string) => void;
  onCard?: (index: number, card: TrackCard) => void;
}) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<TrackCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [deep, setDeep] = useState(false);
  const fetched = useRef(false);
  const cardRef = useRef<TrackCard | null>(null);

  async function load(): Promise<TrackCard | null> {
    if (fetched.current) return cardRef.current;
    fetched.current = true;
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        artist: track.artists[0] || "",
        title: track.title,
      });
      if (track.isrc) qs.set("isrc", track.isrc);
      const res = await fetch(`/api/playlist/track?${qs.toString()}`);
      const data = await res.json();
      const c: TrackCard = res.ok ? data : {};
      cardRef.current = c;
      setCard(c);
      onCard?.(index, c);
      return c;
    } catch {
      const c: TrackCard = {};
      cardRef.current = c;
      setCard(c);
      return c;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (preload) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preload]);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) load();
  }

  async function handlePlay(e: React.MouseEvent) {
    e.stopPropagation();
    const c = card ?? (await load());
    const url = c?.preview?.previewUrl;
    if (url) onTogglePlay(url);
  }

  const previewUrl = card?.preview?.previewUrl;
  const isPlaying = !!previewUrl && playingUrl === previewUrl;
  const art = card?.preview?.artworkUrl || track.image;

  return (
    <div className={`pt-row${open ? " open" : ""}${isPlaying ? " playing" : ""}`}>
      <div className="pt-head">
        <button className="pt-index" onClick={handlePlay} aria-label="Play preview">
          <span className="pt-num">{index + 1}</span>
          <span className="pt-playicon">{isPlaying ? "❚❚" : "▶"}</span>
        </button>

        <button className="pt-main" onClick={toggleOpen}>
          <span className="pt-art">
            {art ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={art} alt="" width={40} height={40} />
            ) : (
              <span className="pt-art-blank" />
            )}
            {isPlaying && (
              <span className="pt-eq">
                <i /><i /><i />
              </span>
            )}
          </span>
          <span className="pt-titles">
            <span className={`pt-title${isPlaying ? " on" : ""}`}>{track.title}</span>
            <span className="pt-artist">{track.artists.join(", ")}</span>
          </span>
        </button>

        <span className="pt-album">{track.album || ""}</span>

        <span className="pt-right">
          {track.isrc && (
            <span className="isrc-dot" title={`ISRC ${track.isrc} · ready to enrich`} />
          )}
          <span className="pt-dur">{dur(track.durationMs)}</span>
          <button className="pt-caretbtn" onClick={toggleOpen} aria-label="Expand">
            {open ? "▾" : "▸"}
          </button>
        </span>
      </div>

      {open && (
        <div className="pt-body">
          {loading && !card && (
            <p className="muted">
              <span className="spinner" /> &nbsp;resolving track…
            </p>
          )}

          {card && (
            <>
              <div className="pt-actions">
                {previewUrl ? (
                  <button className="btn-mini" onClick={handlePlay}>
                    {isPlaying ? "❚❚ Pause" : "▶ Play preview"}
                  </button>
                ) : (
                  <span className="muted">No preview found</span>
                )}
                {card.artistMbid && (
                  <Link className="btn-mini ghost" href={`/artist/${card.artistMbid}`}>
                    {card.artistName} DNA →
                  </Link>
                )}
                {card.credits?.url && (
                  <a
                    className="btn-mini ghost"
                    href={card.credits.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Genius ↗
                  </a>
                )}
              </div>

              {card.credits &&
                (card.credits.producers.length > 0 ||
                  card.credits.writers.length > 0 ||
                  card.credits.releaseDate) && (
                  <div className="pt-credits">
                    {card.credits.releaseDate && (
                      <span className="pt-credit">
                        <span className="pt-credit-k">Released</span>{" "}
                        {card.credits.releaseDate}
                      </span>
                    )}
                    {card.credits.producers.length > 0 && (
                      <span className="pt-credit">
                        <span className="pt-credit-k">Producers</span>{" "}
                        {card.credits.producers.join(", ")}
                      </span>
                    )}
                    {card.credits.writers.length > 0 && (
                      <span className="pt-credit">
                        <span className="pt-credit-k">Writers</span>{" "}
                        {card.credits.writers.join(", ")}
                      </span>
                    )}
                  </div>
                )}

              {previewUrl &&
                (deep ? (
                  <SongXray
                    previewUrl={previewUrl}
                    title={track.title}
                    artist={card.artistName || track.artists[0] || ""}
                  />
                ) : (
                  <button
                    className="btn-mini deep-trigger"
                    onClick={() => setDeep(true)}
                  >
                    🔬 Deep X-ray — key, tempo, energy, stems & producer notes
                  </button>
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
