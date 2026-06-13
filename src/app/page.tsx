"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArtistRef } from "@/lib/types";

export default function Home() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ArtistRef[]>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        setResults(data.artists || []);
      } finally {
        setLoading(false);
      }
    }, 350);
  }, [q]);

  return (
    <div className="home-page">
      <div className="home-hero">
       <div className="hero">
        <h1>The Music Genome Project</h1>
        <p>
          Search any artist and get their DNA — influence lineage, collaborator
          network, and genre evolution, wired into a living knowledge graph.
        </p>
        <div className="search-wrap">
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
                <div className="result-row muted">
                  <span className="spinner" /> &nbsp;searching MusicBrainz…
                </div>
              )}
              {results.map((a) => (
                <div
                  key={a.mbid}
                  className="result-row"
                  onClick={() => router.push(`/artist/${a.mbid}`)}
                >
                  <div>
                    <strong>{a.name}</strong>
                    {a.disambiguation && (
                      <span className="muted"> — {a.disambiguation}</span>
                    )}
                  </div>
                  <div className="result-meta">
                    {[a.type, a.country, a.beginYear].filter(Boolean).join(" · ")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="home-spotify">
          <Link className="btn-ask" href="/ask">
            💬 Ask the Genome — research anything with an AI music agent →
          </Link>
          <Link className="btn-studio" href="/studio">
            🧬 The Genome Studio — generate music from DNA, then score it →
          </Link>
          <span className="home-or" style={{ marginTop: 14 }}>
            or decode your own playlist
          </span>
          <Link className="btn-spotify" href="/playlists">
            Start from a Spotify playlist →
          </Link>
          <Link className="btn" href="/upload" style={{ marginTop: 10 }}>
            🎚️ Analyze your own audio file →
          </Link>
          <Link className="lib-link" href="/library" style={{ marginTop: 8 }}>
            🎵 Your track library →
          </Link>
          <Link className="lib-link" href="/map" style={{ marginTop: 6 }}>
            🗺️ Sonic Map — a playlist by how it sounds →
          </Link>
        </div>
       </div>
      </div>
    </div>
  );
}
