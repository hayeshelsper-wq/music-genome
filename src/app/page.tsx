"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArtistRef } from "@/lib/types";

interface HomeArtist {
  mbid: string;
  name: string;
  tempo_bpm?: number;
  key?: string;
  brightness?: string;
  track: { title: string; previewUrl: string; artworkUrl?: string } | null;
}
interface HomeData {
  artists: HomeArtist[];
  library: { count: number; recent: string[] };
  stats: { artistsMapped: number; libraryTracks: number };
}
interface MapTrack { genre: string; x: number; y: number }

const FEATURES = [
  { href: "/ask", icon: "💬", title: "Ask the Genome", desc: "An AI agent that drives the whole stack to answer questions a search box can't.", accent: "linear-gradient(100deg, var(--influence), var(--collab))" },
  { href: "/studio", icon: "🎛️", title: "The Genome Studio", desc: "Generate music in an artist's DNA — then score how close it actually landed.", accent: "linear-gradient(100deg, var(--root), var(--descendant))" },
  { href: "/trail", icon: "🎧", title: "Influence Trails", desc: "Hear & measure the sonic inheritance between two connected artists.", accent: "linear-gradient(100deg, var(--descendant), var(--collab))" },
  { href: "/lineage", icon: "🧭", title: "Lineage Walk", desc: "An auto-playing documentary that walks a chain of musical influence.", accent: "linear-gradient(100deg, var(--root), var(--influence))" },
  { href: "/atlas", icon: "🗺️", title: "The Living Map", desc: "Watch genres evolve across decades on a map of how music sounds.", accent: "linear-gradient(100deg, var(--collab), var(--root))" },
  { href: "/mashup", icon: "🎚️", title: "Mashup Lab", desc: "Vocals from one track, the beat from another — conformed in key & tempo.", accent: "linear-gradient(100deg, var(--influence), var(--root))" },
  { href: "/showcase", icon: "🔬", title: "Song X-Ray", desc: "Full synthetic metadata for a track — DSP, audio-model read, lyrics & a producer breakdown.", accent: "linear-gradient(100deg, var(--collab), var(--influence))" },
];

const GENRE_COLORS: Record<string, string> = {
  Roots: "#c9a227", Rock: "#ef476f", "Soul/Funk": "#ff9f1c", "Punk/Metal": "#9b5de5",
  "Disco/Electronic": "#00bbf9", "Hip-Hop": "#f15bb5", Pop: "#fee440",
  "Indie/Alt": "#06d6a0", Grunge: "#8d99ae", "R&B": "#5b8def",
};

export default function Home() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ArtistRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<HomeData | null>(null);
  const [mapPts, setMapPts] = useState<MapTrack[]>([]);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then(setData).catch(() => {});
    fetch("/music-map.json").then((r) => r.json()).then((d) => setMapPts(d.tracks || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        setResults((await res.json()).artists || []);
      } finally { setLoading(false); }
    }, 350);
  }, [q]);

  function playArtist(a: HomeArtist) {
    if (!a.track?.previewUrl) return;
    const el = audioRef.current;
    if (!el) return;
    if (nowPlaying === a.mbid) { el.pause(); setNowPlaying(null); return; }
    el.src = a.track.previewUrl; el.play().catch(() => {});
    setNowPlaying(a.mbid);
  }

  return (
    <div className="dash">
      <section className="dash-hero">
        <h1>The Music Genome Project</h1>
        <p>A command center for music intelligence — search any artist for their DNA, or dive into the tools below.</p>
        <div className="search-wrap dash-search">
          <input
            className="search-input"
            placeholder="Search an artist — Radiohead, Aphex Twin, SZA…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          {(results.length > 0 || loading) && (
            <div className="results">
              {loading && results.length === 0 && (
                <div className="result-row muted"><span className="spinner" /> &nbsp;searching MusicBrainz…</div>
              )}
              {results.map((a) => (
                <div key={a.mbid} className="result-row" onClick={() => router.push(`/artist/${a.mbid}`)}>
                  <div><strong>{a.name}</strong>{a.disambiguation && <span className="muted"> — {a.disambiguation}</span>}</div>
                  <div className="result-meta">{[a.type, a.country, a.beginYear].filter(Boolean).join(" · ")}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        {data && (
          <div className="dash-stats">
            <span><b>{data.stats.artistsMapped}</b> artists mapped</span>
            <span><b>{mapPts.length || 67}</b> landmarks on the map</span>
            <span><b>{data.stats.libraryTracks}</b> tracks in your library</span>
          </div>
        )}
      </section>

      <section className="dash-section">
        <h2 className="dash-h2">Explore the toolkit</h2>
        <div className="feat-grid">
          {FEATURES.map((f) => (
            <Link key={f.href} href={f.href} className="feat-tile">
              <span className="feat-bar" style={{ background: f.accent }} />
              <div className="feat-icon">{f.icon}</div>
              <div className="feat-title">{f.title}</div>
              <div className="feat-desc">{f.desc}</div>
              <span className="feat-go">Open →</span>
            </Link>
          ))}
        </div>
      </section>

      {data && data.artists.length > 0 && (
        <section className="dash-section">
          <div className="dash-h2-row">
            <h2 className="dash-h2">Recently in the genome</h2>
            <span className="muted dash-h2-sub">artists already analyzed — tap art to preview, click to open their DNA</span>
          </div>
          <div className="artist-strip">
            {data.artists.map((a) => (
              <div key={a.mbid} className="artist-card">
                <button
                  className="artist-art"
                  onClick={() => playArtist(a)}
                  style={a.track?.artworkUrl ? { backgroundImage: `url(${a.track.artworkUrl})` } : {}}
                  aria-label={`Preview ${a.name}`}
                >
                  <span className="artist-play">{nowPlaying === a.mbid ? "⏸" : "▶"}</span>
                </button>
                <Link href={`/artist/${a.mbid}`} className="artist-name">{a.name}</Link>
                <div className="artist-meta muted">{[a.tempo_bpm && `${a.tempo_bpm} BPM`, a.key].filter(Boolean).join(" · ")}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {mapPts.length > 0 && (
        <section className="dash-section">
          <Link href="/atlas" className="map-preview">
            <svg viewBox="0 0 1000 240" preserveAspectRatio="xMidYMid slice" className="map-preview-svg">
              {mapPts.map((p, i) => (
                <circle key={i} cx={20 + p.x * 960} cy={20 + (1 - p.y) * 200} r={4.5}
                  fill={GENRE_COLORS[p.genre] || "#9a9ab0"} opacity={0.9} />
              ))}
            </svg>
            <div className="map-preview-cta">
              <div className="map-preview-title">🗺️ The Living Map of Music</div>
              <div className="muted">{mapPts.length} landmark tracks placed by how they sound · open to scrub the decades →</div>
            </div>
          </Link>
        </section>
      )}

      <section className="dash-section dash-decode">
        <h2 className="dash-h2">Decode your own</h2>
        <div className="decode-row">
          <Link className="decode-tile" href="/playlists"><b>🎵 Spotify playlist</b><span className="muted">X-ray every track in any playlist</span></Link>
          <Link className="decode-tile" href="/upload"><b>🎚️ Upload audio</b><span className="muted">analyze a full song you own</span></Link>
          <Link className="decode-tile" href="/library"><b>📚 Your library</b><span className="muted">{data ? `${data.library.count} analyzed tracks` : "your analyzed tracks"}</span></Link>
          <Link className="decode-tile" href="/map"><b>🌀 Sonic Map</b><span className="muted">a playlist laid out by sound</span></Link>
        </div>
      </section>

      <footer className="dash-footer muted">
        Built on Next.js · FastAPI · CLAP · Demucs · MusicGen · Claude · Google Cloud
      </footer>

      <audio ref={audioRef} hidden onEnded={() => setNowPlaying(null)} />
    </div>
  );
}
