"use client";

import { useEffect, useState } from "react";
import SongXray from "@/components/SongXray";

interface Featured { artist: string; title: string; previewUrl: string; artwork?: string }

export default function XrayShowcase() {
  const [songs, setSongs] = useState<Featured[]>([]);
  const [sel, setSel] = useState<Featured | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    fetch("/api/showcase")
      .then((r) => r.json())
      .then((d) => {
        const list: Featured[] = (d.songs || []).filter((s: Featured) => s.previewUrl);
        setSongs(list);
        setSel(list[0] || null);
        if (!list.length) setErr(true);
      })
      .catch(() => setErr(true));
  }, []);

  return (
    <div className="showcase">
      <div className="showcase-head">
        <h2>Song X-Ray — featured</h2>
        <p className="muted">
          The full synthetic metadata for a track: measured DSP (librosa), instrument
          / mood / genre tags (Essentia), the <strong>Music Flamingo</strong> audio-model
          read, accurate lyrics, and a Grammy-producer-style breakdown written by Claude.
          These are <strong>pre-rendered</strong> and cached, so they load instantly —
          no GPU cold start.
        </p>
      </div>

      {err && <p className="muted">No featured X-Rays yet. Run <code>scripts/build-xray-examples.ts</code> to pre-render some.</p>}

      {songs.length > 0 && (
        <div className="showcase-picker">
          {songs.map((s) => (
            <button
              key={`${s.artist}-${s.title}`}
              className={`showcase-card ${sel?.title === s.title && sel?.artist === s.artist ? "on" : ""}`}
              onClick={() => setSel(s)}
            >
              {s.artwork && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.artwork} alt={s.title} />
              )}
              <div className="showcase-card-title">{s.title}</div>
              <div className="showcase-card-artist muted">{s.artist}</div>
            </button>
          ))}
        </div>
      )}

      {sel && (
        <div className="showcase-xray">
          <div className="showcase-now">
            🎧 <strong>{sel.title}</strong> — {sel.artist}
          </div>
          <SongXray key={`${sel.artist}-${sel.title}`} previewUrl={sel.previewUrl} title={sel.title} artist={sel.artist} />
        </div>
      )}
    </div>
  );
}
