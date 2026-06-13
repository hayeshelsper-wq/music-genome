"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

interface MapPoint {
  title: string;
  artist: string;
  image: string;
  previewUrl: string;
  x: number;
  y: number;
  cluster: number;
  vec?: string | null; // base64 int8, baked offline
}
interface MapData {
  playlist: string;
  count: number;
  k: number;
  tracks: MapPoint[];
  vscale?: number;
}

// one hue per KMeans cluster
const CLUSTER_COLORS = [
  "#6db1ff",
  "#ff9bb0",
  "#8fe3b0",
  "#f5d06b",
  "#c9a0ff",
  "#7fe0e6",
  "#ffb37a",
  "#9aa7ff",
];

// pre-baked maps — each is a static artifact built offline (CLAP → UMAP)
const MAPS = [
  { id: "some-cool", label: "Some cool ones", file: "/sonic-map-some-cool.json" },
  { id: "indie", label: "Indie picks", file: "/sonic-map-indie.json" },
  {
    id: "man-underground",
    label: "Man Underground",
    file: "/sonic-map-man-underground.json",
  },
];

// decode a baked base64 int8 vector into a signed array
function decodeVec(b64: string): Int8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Int8Array(u.buffer);
}

export default function SonicMapPage() {
  const [mapId, setMapId] = useState(MAPS[0].id);
  const [data, setData] = useState<MapData | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // per-track normalized match score (0..1) for the active query, or null
  const [scores, setScores] = useState<number[] | null>(null);
  const [activeQuery, setActiveQuery] = useState("");
  // player state — which track is loaded, whether it's playing, and progress 0..1
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // warm the audio-service (and its CLAP model) in the background on page load,
  // so the first natural-language search doesn't pay the full cold-start latency
  useEffect(() => {
    fetch("/api/embed-text?q=warmup").catch(() => {});
  }, []);

  useEffect(() => {
    const m = MAPS.find((x) => x.id === mapId) || MAPS[0];
    setData(null);
    setHover(null);
    setScores(null);
    setActiveQuery("");
    // stop and reset the player when switching maps
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
    }
    setPlayingIdx(null);
    setIsPlaying(false);
    setProgress(0);
    fetch(m.file)
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ playlist: "", count: 0, k: 0, tracks: [] }));
  }, [mapId]);

  // decode the baked per-track vectors once per map
  const vecs = useMemo(() => {
    if (!data) return null;
    return data.tracks.map((t) => (t.vec ? decodeVec(t.vec) : null));
  }, [data]);

  // load + play track i (or just resume if it's already the loaded one)
  function play(i: number) {
    const a = audioRef.current;
    const p = data?.tracks[i];
    if (!a || !p?.previewUrl) return;
    if (playingIdx !== i) {
      a.src = p.previewUrl;
      a.currentTime = 0;
      setPlayingIdx(i);
      setProgress(0);
    }
    a.play().catch(() => {});
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }

  function stop() {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    setProgress(0);
  }

  function seek(frac: number) {
    const a = audioRef.current;
    if (a && a.duration) {
      a.currentTime = Math.max(0, Math.min(1, frac)) * a.duration;
    }
  }

  async function runSearch() {
    const q = query.trim();
    if (!q || !data || !vecs) return;
    setSearching(true);
    try {
      const r = await fetch(`/api/embed-text?q=${encodeURIComponent(q)}`);
      const j = await r.json();
      const qv = j.embedding as number[] | null;
      if (!Array.isArray(qv)) {
        setScores(null);
        setActiveQuery("");
        return;
      }
      // raw dot product of the float query vs each baked int8 track vector
      const raw = vecs.map((v) => {
        if (!v) return -Infinity;
        let s = 0;
        for (let i = 0; i < v.length; i++) s += qv[i] * v[i];
        return s;
      });
      const finite = raw.filter((x) => Number.isFinite(x));
      const lo = Math.min(...finite);
      const hi = Math.max(...finite);
      const span = hi - lo || 1;
      // min-max normalize (text↔audio scores are compressed by the modality gap)
      const norm = raw.map((x) =>
        Number.isFinite(x) ? (x - lo) / span : 0
      );
      setScores(norm);
      setActiveQuery(q);
    } catch {
      setScores(null);
      setActiveQuery("");
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setQuery("");
    setScores(null);
    setActiveQuery("");
  }

  // the enlarged/active dot follows the cursor, falling back to what's playing
  const active = hover ?? playingIdx;
  const cur = playingIdx != null && data ? data.tracks[playingIdx] : null;

  // ranked top matches for the active query (for the list + caption)
  const topMatches = useMemo(() => {
    if (!scores || !data) return [];
    return scores
      .map((s, i) => ({ i, s }))
      .filter((m) => Number.isFinite(m.s))
      .sort((a, b) => b.s - a.s)
      .slice(0, 6);
  }, [scores, data]);
  const topMatch = topMatches.length && data ? data.tracks[topMatches[0].i] : null;

  function playOrToggle(i: number) {
    if (i === playingIdx) togglePlay();
    else play(i);
  }

  return (
    <div className="map-page">
      <div className="up-hero">
        <div className="up-hero-inner">
          <div className="up-topnav">
            <Link href="/" className="up-navlink">
              ← home
            </Link>
            <Link href="/library" className="up-navlink lib">
              your library →
            </Link>
          </div>
          <span className="up-eyebrow">Studio · Sonic Map</span>
          <h1>🗺️ The sound of “{data?.playlist || "…"}”</h1>
          <p>
            {data?.count || 0} tracks placed by <strong>how they actually sound</strong> —
            each song&apos;s audio was embedded with CLAP and projected to 2-D, so
            sonic neighbors sit together. Hover a cover to hear its 30-second
            preview; color marks a sonic cluster.
          </p>
          <div className="map-switch">
            {MAPS.map((m) => (
              <button
                key={m.id}
                className={`map-switch-btn${m.id === mapId ? " on" : ""}`}
                onClick={() => setMapId(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="map-wrap">
        {!data && (
          <p className="muted" style={{ padding: 24 }}>
            <span className="spinner" /> loading the map…
          </p>
        )}
        {data && (
          <>
            <div className="map-search">
              <input
                className="map-search-input"
                placeholder="Describe a sound — “dreamy and slow”, “fuzzy guitars”, “upbeat synth pop”…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runSearch();
                }}
              />
              <button
                className="map-search-go"
                onClick={runSearch}
                disabled={searching || !query.trim()}
              >
                {searching ? <span className="spinner" /> : "🔦 light it up"}
              </button>
              {scores && (
                <button className="map-search-clear" onClick={clearSearch}>
                  clear
                </button>
              )}
            </div>

            <div
              className={`map-stage${data.tracks.length > 120 ? " dense" : ""}${
                scores ? " searching" : ""
              }`}
              onMouseLeave={() => setHover(null)}
            >
              {data.tracks.map((p, i) => {
                const on = i === active;
                const score = scores ? scores[i] : null;
                // gamma-shaped opacity so the best matches pop and weak ones fade
                const lit =
                  score != null ? 0.08 + 0.92 * Math.pow(score, 1.6) : null;
                const isTop = score != null && score >= 0.82;
                return (
                  <button
                    key={i}
                    className={`map-dot${on ? " on" : ""}${
                      isTop ? " top" : ""
                    }`}
                    style={{
                      left: `${p.x * 100}%`,
                      top: `${p.y * 100}%`,
                      borderColor:
                        CLUSTER_COLORS[p.cluster % CLUSTER_COLORS.length],
                      zIndex: on ? 20 : isTop ? 10 : 1,
                      ...(lit != null ? { opacity: lit } : {}),
                    }}
                    onMouseEnter={() => {
                      setHover(i);
                      play(i);
                    }}
                    onClick={() => play(i)}
                    title={`${p.title} — ${p.artist}`}
                    aria-label={`${p.title} by ${p.artist}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.image} alt="" loading="lazy" />
                  </button>
                );
              })}
            </div>

            <div className="map-foot">
              {cur ? (
                <div className="map-player">
                  <button
                    className="map-play-btn"
                    onClick={togglePlay}
                    aria-label={isPlaying ? "Pause" : "Play"}
                    title={isPlaying ? "Pause" : "Play"}
                  >
                    {isPlaying ? (
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                        <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="map-player-art" src={cur.image} alt="" />
                  <div className="map-player-meta">
                    <div className="map-now-title">{cur.title}</div>
                    <div className="map-now-artist muted">{cur.artist}</div>
                  </div>
                  <div
                    className="map-prog"
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      seek((e.clientX - r.left) / r.width);
                    }}
                  >
                    <div
                      className="map-prog-fill"
                      style={{ width: `${progress * 100}%` }}
                    />
                  </div>
                  <button
                    className="map-stop-btn"
                    onClick={stop}
                    aria-label="Stop"
                    title="Stop"
                  >
                    ✕
                  </button>
                </div>
              ) : activeQuery && topMatch ? (
                <div className="muted map-hint">
                  🔦 brightest covers sound most like{" "}
                  <strong style={{ color: "#cfe0ff" }}>
                    “{activeQuery}”
                  </strong>{" "}
                  · closest match: <strong>{topMatch.title}</strong> —{" "}
                  {topMatch.artist}
                </div>
              ) : (
                <div className="muted map-hint">
                  Hover any cover to hear it · built offline with CLAP audio
                  embeddings + UMAP · closer = more sonically similar
                </div>
              )}
            </div>

            {activeQuery && topMatches.length > 0 && (
              <div className="map-matches">
                <div className="map-matches-head">
                  Top matches for{" "}
                  <strong>“{activeQuery}”</strong>
                  <span className="muted"> · tap to sample</span>
                </div>
                {topMatches.map((m, rank) => {
                  const t = data.tracks[m.i];
                  const isCur = m.i === playingIdx;
                  return (
                    <button
                      key={m.i}
                      className={`map-match${isCur ? " on" : ""}`}
                      onClick={() => playOrToggle(m.i)}
                      onMouseEnter={() => setHover(m.i)}
                      onMouseLeave={() => setHover(null)}
                    >
                      <span className="map-match-rank">{rank + 1}</span>
                      <span className="map-match-play">
                        {isCur && isPlaying ? (
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                            <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </span>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={t.image} alt="" />
                      <span className="map-match-meta">
                        <span className="map-match-title">{t.title}</span>
                        <span className="map-match-artist muted">
                          {t.artist}
                        </span>
                      </span>
                      <span className="map-match-bar">
                        <span
                          className="map-match-bar-fill"
                          style={{ width: `${Math.round(m.s * 100)}%` }}
                        />
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        preload="none"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setProgress(0);
        }}
        onTimeUpdate={(e) => {
          const a = e.currentTarget;
          if (a.duration) setProgress(a.currentTime / a.duration);
        }}
      />
    </div>
  );
}
