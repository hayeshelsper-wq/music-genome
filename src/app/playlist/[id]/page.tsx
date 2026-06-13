"use client";

import { CSSProperties, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import PlaylistTrack, { SpotifyTrack, TrackCard } from "@/components/PlaylistTrack";
import { useVibrantColor } from "@/components/useVibrantColor";

interface Playlist {
  name: string;
  description?: string;
  image?: string;
  tracks: SpotifyTrack[];
}

// How many tracks get their light card fetched up front so opening is instant.
const PRELOAD = 4;

function totalDuration(tracks: SpotifyTrack[]): string {
  const ms = tracks.reduce((a, t) => a + (t.durationMs || 0), 0);
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} hr ${min % 60} min`;
}

export default function PlaylistPage() {
  const { id } = useParams<{ id: string }>();
  const [pl, setPl] = useState<Playlist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cardsRef = useRef<Map<number, TrackCard>>(new Map());
  const rgb = useVibrantColor(pl?.image);

  useEffect(() => {
    setPl(null);
    setError(null);
    setPlayingUrl(null);
    cardsRef.current = new Map();
    (async () => {
      try {
        const res = await fetch(`/api/spotify/playlist/${id}`);
        if (res.status === 401) {
          setError("not_authenticated");
          return;
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "failed");
        setPl(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed");
      }
    })();
  }, [id]);

  // Liner notes — an editorial through-line for the whole playlist (best-effort,
  // fades in after the tracklist loads).
  useEffect(() => {
    if (!pl) return;
    let alive = true;
    setNotes(null);
    fetch(`/api/playlist/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: pl.name,
        description: pl.description,
        tracks: pl.tracks.map((t) => ({
          title: t.title,
          artist: t.artists?.[0] || "",
          album: t.album,
        })),
      }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (alive && j.notes) setNotes(j.notes);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pl]);

  // Centralized audio: only one preview plays at a time. We track the playing
  // track's INDEX (not just its URL) so the list can auto-advance when a preview
  // ends — and so duplicate preview URLs (e.g. two mixes of the same song) don't
  // confuse which track comes next.
  const playingIndexRef = useRef(-1);

  function urlAt(i: number): string | undefined {
    return cardsRef.current.get(i)?.preview?.previewUrl;
  }

  function stopPlayback() {
    audioRef.current?.pause();
    playingIndexRef.current = -1;
    setPlayingUrl(null);
  }

  function playIndex(i: number): boolean {
    const el = audioRef.current;
    const url = urlAt(i);
    if (!el || !url) return false;
    el.src = url;
    el.play().catch(stopPlayback);
    playingIndexRef.current = i;
    setPlayingUrl(url);
    return true;
  }

  // Clicking an individual row toggles just that track.
  function togglePlay(url: string) {
    if (playingUrl === url) {
      stopPlayback();
      return;
    }
    if (!pl) return;
    for (let i = 0; i < pl.tracks.length; i++) {
      if (urlAt(i) === url) {
        playIndex(i);
        return;
      }
    }
  }

  function onCard(i: number, c: TrackCard) {
    cardsRef.current.set(i, c);
  }

  // Auto-advance: when a preview ends, play the next track that has a preview;
  // stop only after the last one.
  function playNext() {
    if (!pl) return stopPlayback();
    for (let i = playingIndexRef.current + 1; i < pl.tracks.length; i++) {
      if (playIndex(i)) return;
    }
    stopPlayback();
  }

  // The big play button: start from the top (or stop if already playing).
  function playFirst() {
    if (!pl) return;
    if (playingUrl) {
      stopPlayback();
      return;
    }
    playingIndexRef.current = -1;
    playNext();
  }

  if (error === "not_authenticated")
    return (
      <div className="container center" style={{ paddingTop: 120 }}>
        <p className="muted">Your Spotify session expired.</p>
        <a className="btn-spotify" href="/api/spotify/login">
          Reconnect with Spotify
        </a>
      </div>
    );

  if (error)
    return (
      <div className="container" style={{ paddingTop: 40 }}>
        <Link href="/playlists" className="muted">
          ← playlists
        </Link>
        <div className="notice" style={{ marginTop: 16 }}>Error: {error}</div>
      </div>
    );

  if (!pl)
    return (
      <div className="container center" style={{ paddingTop: 120 }}>
        <span className="spinner" />
        <p className="muted">loading tracks…</p>
      </div>
    );

  const withIsrc = pl.tracks.filter((t) => t.isrc).length;
  const heroStyle = {
    "--hero-rgb": `${rgb[0]} ${rgb[1]} ${rgb[2]}`,
  } as CSSProperties;

  return (
    <div className="pl-page" style={heroStyle}>
      <audio ref={audioRef} hidden onEnded={playNext} />

      <div className="pl-hero">
        <Link href="/playlists" className="pl-back">
          ← playlists
        </Link>
        <div className="pl-hero-inner">
          <div className="pl-cover">
            {pl.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={pl.image} alt="" />
            ) : (
              <span className="pl-cover-blank">♪</span>
            )}
          </div>
          <div className="pl-hero-text">
            <span className="pl-eyebrow">Playlist</span>
            <h1 className="pl-title">{pl.name}</h1>
            {pl.description && <p className="pl-desc">{pl.description}</p>}
            <div className="pl-meta">
              <span className="pl-meta-strong">{pl.tracks.length} songs</span>
              <span className="pl-dot">·</span>
              {totalDuration(pl.tracks)}
              <span className="pl-dot">·</span>
              <span className="pl-enrich">{withIsrc} ready to decode</span>
            </div>
          </div>
        </div>
      </div>

      <div className="pl-body">
        <div className="pl-actionbar">
          <button
            className="pl-bigplay"
            onClick={playFirst}
            aria-label={playingUrl ? "Pause" : "Play previews"}
          >
            {playingUrl ? "❚❚" : "▶"}
          </button>
          <p className="pl-actionhint">
            Click a track to expand its preview, credits & a deep X-ray. Tap an
            artist for their full DNA.
          </p>
        </div>

        {notes && (
          <div className={`pl-linernotes ${notesOpen ? "open" : ""}`}>
            <button
              className="pl-notes-toggle"
              onClick={() => setNotesOpen((o) => !o)}
              aria-expanded={notesOpen}
            >
              <span className="stat-label">📝 Liner Notes</span>
              <span className="pl-notes-chevron">▾</span>
            </button>
            {notesOpen && <p>{notes}</p>}
          </div>
        )}

        <div className="pt-listhead">
          <span>#</span>
          <span>Title</span>
          <span className="pt-col-album">Album</span>
          <span className="pt-col-dur">⏱</span>
        </div>

        <div className="pt-list">
          {pl.tracks.map((t, i) => (
            <PlaylistTrack
              key={`${t.id}-${i}`}
              track={t}
              index={i}
              preload={i < PRELOAD}
              playingUrl={playingUrl}
              onTogglePlay={togglePlay}
              onCard={onCard}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
