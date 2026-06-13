"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
  image?: string;
  owner?: string;
  description?: string;
  collaborative?: boolean;
}

export default function PlaylistsPage() {
  return (
    <Suspense>
      <PlaylistsInner />
    </Suspense>
  );
}

function PlaylistsInner() {
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const params = useSearchParams();
  const oauthError = params.get("error");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/spotify/playlists");
        if (res.status === 401) {
          setNeedsAuth(true);
          return;
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "failed");
        setPlaylists(data.playlists || []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed");
      }
    })();
  }, []);

  // ---- not connected: show the Spotify login CTA ----
  if (needsAuth)
    return (
      <div className="container center" style={{ paddingTop: 120 }}>
        <Link href="/" className="muted">
          ← home
        </Link>
        <div className="hero" style={{ marginTop: 24 }}>
          <h1>Your playlists, decoded</h1>
          <p>
            Connect Spotify and pick a playlist — we&apos;ll turn it into an
            explorable feed: influence lineage, audio DNA, lyrics, stems and
            producer credits for every song and artist in it.
          </p>
          {oauthError && (
            <div className="notice">
              Couldn&apos;t connect ({oauthError}). Make sure your Spotify email
              is added under the app&apos;s <strong>User Management</strong> and
              you&apos;re on Premium, then try again.
            </div>
          )}
          <a className="btn btn-spotify" href="/api/spotify/login">
            Connect with Spotify
          </a>
          <p className="hint" style={{ marginTop: 14 }}>
            Read-only. We never post or change anything in your account.
          </p>
        </div>
      </div>
    );

  if (error)
    return (
      <div className="container" style={{ paddingTop: 40 }}>
        <Link href="/" className="muted">
          ← home
        </Link>
        <div className="notice" style={{ marginTop: 16 }}>
          Spotify error: {error}
        </div>
        <a className="btn" href="/api/spotify/login" style={{ marginTop: 12 }}>
          Reconnect Spotify
        </a>
      </div>
    );

  if (!playlists)
    return (
      <div className="container center" style={{ paddingTop: 120 }}>
        <span className="spinner" />
        <p className="muted">loading your playlists…</p>
      </div>
    );

  return (
    <div className="container">
      <div className="report-header" style={{ marginTop: 16 }}>
        <Link href="/" className="muted">
          ← home
        </Link>
        <h1>Pick a playlist</h1>
        <span className="sub">{playlists.length} playlists · click one to decode it</span>
      </div>

      <div className="pl-grid">
        {playlists.map((p) => (
          <button
            key={p.id}
            className="pl-card"
            onClick={() => router.push(`/playlist/${p.id}`)}
          >
            <span className="pl-art">
              {p.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.image} alt="" width={120} height={120} />
              ) : (
                <span className="pl-art-blank" />
              )}
            </span>
            <span className="pl-meta">
              <span className="pl-name">{p.name}</span>
              <span className="pl-sub">
                {p.trackCount} track{p.trackCount === 1 ? "" : "s"}
                {p.owner ? ` · ${p.owner}` : ""}
              </span>
            </span>
          </button>
        ))}
      </div>

      <p className="hint" style={{ marginTop: 28 }}>
        <a className="muted" href="/api/spotify/logout">
          Disconnect Spotify
        </a>
      </p>
    </div>
  );
}
