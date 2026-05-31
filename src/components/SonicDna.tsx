"use client";

import { useEffect, useRef, useState } from "react";
import SongXray from "./SongXray";

interface TopTrack {
  title: string;
  album?: string;
  artworkUrl?: string;
  previewUrl?: string;
  trackTimeMs?: number;
  releaseYear?: number;
  genre?: string;
}
interface AudioProfile {
  sampleSize: number;
  avgBpm: number | null;
  keys: { key: string; count: number }[];
  danceability: number | null;
  moods: { name: string; score: number }[];
  genres: { name: string; score: number }[];
}
export default function SonicDna({
  mbid,
  name,
  onName,
}: {
  mbid: string;
  /** Optional — when omitted, the /audio route resolves the name from MusicBrainz. */
  name?: string;
  /** Called with the resolved artist name (useful in graph-less fallback mode). */
  onName?: (n: string) => void;
}) {
  const [tracks, setTracks] = useState<TopTrack[] | null>(null);
  const [profile, setProfile] = useState<AudioProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [selected, setSelected] = useState<TopTrack | null>(null);
  const [artistName, setArtistName] = useState<string>(name || "");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    setTracks(null);
    setProfile(null);
    setError(null);
    setSelected(null);

    // Fast path: previews + artwork render as soon as iTunes responds.
    (async () => {
      try {
        const url = name
          ? `/api/artist/${mbid}/audio?name=${encodeURIComponent(name)}`
          : `/api/artist/${mbid}/audio`;
        const res = await fetch(url);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "failed");
        if (alive) {
          setTracks(json.topTracks || []);
          if (json.artist?.name) {
            setArtistName(json.artist.name);
            onName?.(json.artist.name);
          }
        }
      } catch (e: any) {
        if (alive) setError(e.message);
      }
    })();

    // Slow, best-effort path: AcousticBrainz audio features fade in if/when they
    // arrive. AcousticBrainz is flaky, so retry once on an empty/failed result
    // (the server doesn't cache nulls, so a retry recomputes and often succeeds).
    // Persistent failure stays silent — the previews stand on their own.
    (async () => {
      for (let attempt = 0; attempt < 2 && alive; attempt++) {
        try {
          const res = await fetch(`/api/artist/${mbid}/audio-features`);
          const json = await res.json();
          if (alive && json.audioProfile) {
            setProfile(json.audioProfile);
            return;
          }
        } catch {
          /* ignore and retry */
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();

    return () => {
      alive = false;
      audioRef.current?.pause();
    };
  }, [mbid, name]);

  function toggle(track: TopTrack) {
    if (!track.previewUrl) return;
    const el = audioRef.current;
    if (!el) return;
    if (playing === track.previewUrl) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.src = track.previewUrl;
    el.play().catch(() => setPlaying(null));
    setPlaying(track.previewUrl);
  }

  if (error)
    return <p className="muted">Couldn’t load previews: {error}</p>;

  if (!tracks)
    return (
      <p className="muted">
        <span className="spinner" /> &nbsp;pulling previews from iTunes…
      </p>
    );

  const audioProfile = profile;

  if (tracks.length === 0 && !audioProfile)
    return (
      <p className="muted">No previews found for this artist on iTunes.</p>
    );

  return (
    <div>
      <audio ref={audioRef} onEnded={() => setPlaying(null)} hidden />

      {/* ---- aggregated audio-feature profile (best-effort, fades in) ---- */}
      {audioProfile && (
        <div className="sonic-grid">
          <div className="stat-card">
            <div className="stat-label">Typical tempo</div>
            <div className="stat-value">
              {audioProfile.avgBpm ?? "—"}
              <span className="stat-unit">BPM</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Prevailing key</div>
            <div className="stat-value stat-key">
              {audioProfile.keys[0]?.key ?? "—"}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Danceability</div>
            {audioProfile.danceability != null ? (
              <>
                <div className="meter">
                  <div
                    className="meter-fill"
                    style={{ width: `${Math.round(audioProfile.danceability * 100)}%` }}
                  />
                </div>
                <div className="stat-sub">
                  {Math.round(audioProfile.danceability * 100)}%
                </div>
              </>
            ) : (
              <div className="stat-value">—</div>
            )}
          </div>
          <div className="stat-card stat-wide">
            <div className="stat-label">Mood mix</div>
            <div className="mood-chips">
              {audioProfile.moods.length ? (
                audioProfile.moods.map((m) => (
                  <span
                    key={m.name}
                    className="mood-chip"
                    style={{ opacity: 0.5 + m.score * 0.5 }}
                  >
                    {m.name} {Math.round(m.score * 100)}%
                  </span>
                ))
              ) : (
                <span className="muted">—</span>
              )}
            </div>
          </div>
        </div>
      )}
      {audioProfile && (
        <p className="hint" style={{ marginTop: 10 }}>
          Aggregated from {audioProfile.sampleSize} analyzed recording
          {audioProfile.sampleSize === 1 ? "" : "s"} · AcousticBrainz
        </p>
      )}

      {/* ---- playable top tracks ---- */}
      {tracks.length > 0 && (
        <>
          <p className="hint" style={{ marginTop: 16 }}>
            Click a track to play it and X-ray it — key, tempo, arrangement,
            lyrics & a producer breakdown.
          </p>
          <div className="track-list">
            {tracks.map((t) => {
              const isPlaying = playing === t.previewUrl;
              const isSelected = selected?.previewUrl === t.previewUrl;
              return (
                <button
                  key={`${t.title}-${t.album}`}
                  className={`track-row${isPlaying ? " playing" : ""}${
                    isSelected ? " selected" : ""
                  }`}
                  onClick={() => {
                    toggle(t);
                    if (t.previewUrl) setSelected(t);
                  }}
                  disabled={!t.previewUrl}
                >
                  <span className="track-art">
                    {t.artworkUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.artworkUrl} alt="" width={44} height={44} />
                    ) : (
                      <span className="track-art-blank" />
                    )}
                    <span className="track-play">{isPlaying ? "❚❚" : "▶"}</span>
                  </span>
                  <span className="track-meta">
                    <span className="track-title">{t.title}</span>
                    <span className="track-album">
                      {[t.album, t.releaseYear].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {isPlaying && <span className="track-eq">♪</span>}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* ---- per-song deep analysis ---- */}
      {selected?.previewUrl && (
        <SongXray
          previewUrl={selected.previewUrl}
          title={selected.title}
          artist={artistName}
        />
      )}
    </div>
  );
}
