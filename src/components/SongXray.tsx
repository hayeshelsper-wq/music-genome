"use client";

import { useEffect, useState } from "react";
import StemLab from "./StemLab";

interface Features {
  tempo_bpm: number;
  tempo_feel: string;
  key: string;
  key_confidence: number;
  harmonic_emphasis: string[];
  brightness: string;
  texture: string;
  density: string;
  dynamics: string;
  energy_arc: number[];
  energy_shape: string;
}
interface Analysis {
  features: Features | null;
  chromagram: string | null;
  genius: {
    fullTitle: string;
    url: string;
    releaseDate?: string;
    producers: string[];
    writers: string[];
  } | null;
  flamingo: string;
  fullLyrics: string;
  notableLyrics: string[];
  lyricsSource: string;
  breakdown: string;
  model: string;
  error?: string;
}

export default function SongXray({
  previewUrl,
  title,
  artist,
}: {
  previewUrl: string;
  title: string;
  artist: string;
}) {
  const [data, setData] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showStems, setShowStems] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    setShowStems(false);
    (async () => {
      try {
        const url = `/api/track/analyze?previewUrl=${encodeURIComponent(
          previewUrl
        )}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`;
        const res = await fetch(url);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "analysis failed");
        if (alive) setData(json);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "failed");
      }
    })();
    return () => {
      alive = false;
    };
  }, [previewUrl, title, artist]);

  if (error)
    return (
      <div className="xray">
        <p className="muted">
          Couldn’t analyze this track: {error}
          <br />
          <span style={{ fontSize: 12 }}>
            (the Python audio service must be running — see audio-service/README)
          </span>
        </p>
      </div>
    );

  if (!data)
    return (
      <div className="xray">
        <div className="xray-loading">
          <span className="spinner" />
          <div>
            <strong>X-raying “{title}”…</strong>
            <div className="muted" style={{ fontSize: 13 }}>
              librosa measurement → Music Flamingo (NVIDIA audio-LLM on GPU) →
              Genius → a Grammy-producer critique. First run ~30–60s, then instant.
            </div>
          </div>
        </div>
      </div>
    );

  const f = data.features;
  return (
    <div className="xray">
      <div className="xray-head">
        <h3>🔬 Song X-Ray — {title}</h3>
        {data.genius?.url && (
          <a href={data.genius.url} target="_blank" rel="noreferrer" className="xray-genius">
            Genius ↗
          </a>
        )}
      </div>

      {/* measured features */}
      {f && (
        <div className="xray-stats">
          <Stat label="Key" value={f.key} sub={`conf ${f.key_confidence}`} />
          <Stat label="Tempo" value={`${f.tempo_bpm}`} unit="BPM" sub={f.tempo_feel} />
          <Stat label="Texture" value={f.texture} />
          <Stat label="Brightness" value={f.brightness} />
          <Stat label="Density" value={f.density} />
          <Stat label="Dynamics" value={f.dynamics} />
        </div>
      )}

      {/* energy arc + chromagram side by side */}
      <div className="xray-viz">
        {f && (
          <div className="xray-arc-wrap">
            <div className="stat-label">
              Energy across the clip · {f.energy_shape}
            </div>
            <div className="xray-arc">
              {f.energy_arc.map((v, i) => (
                <div
                  key={i}
                  className="xray-bar"
                  style={{ height: `${Math.max(6, (v / Math.max(...f.energy_arc)) * 100)}%` }}
                />
              ))}
            </div>
            <div className="stat-label" style={{ marginTop: 6 }}>
              Harmonic emphasis: {f.harmonic_emphasis.join(" · ")}
            </div>
          </div>
        )}
        {data.chromagram && (
          <div className="xray-chroma">
            <div className="stat-label">Chromagram (pitch content over time)</div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={data.chromagram} alt="chromagram" />
          </div>
        )}
      </div>

      {/* Music Flamingo — AI listener's musician read */}
      {data.flamingo && (
        <details className="xray-flamingo">
          <summary>
            🦩 Music Flamingo heard this <span className="muted">(NVIDIA audio-LLM — informed but fallible)</span>
          </summary>
          <div className="xray-flamingo-body">{data.flamingo}</div>
        </details>
      )}

      {/* The producer's critique (LLM, grounded in measurements + Flamingo) */}
      {data.breakdown && (
        <div className="xray-breakdown">
          <div className="stat-label">🎙️ The Producer’s Critique</div>
          <p>{data.breakdown}</p>
          <div className="xray-model muted">
            critique by {data.model}
            {data.flamingo ? " · informed by Music Flamingo + librosa" : " · from librosa measurements"}
          </div>
        </div>
      )}

      {/* notable lyrics + credits */}
      <div className="xray-foot">
        {data.notableLyrics.length > 0 && (
          <div className="xray-lyrics">
            <div className="stat-label">Notable lyrics</div>
            {data.notableLyrics.map((l, i) => (
              <div key={i} className="xray-lyric">“{l}”</div>
            ))}
          </div>
        )}
        {data.genius && (data.genius.writers.length > 0 || data.genius.producers.length > 0) && (
          <div className="xray-credits">
            {data.genius.releaseDate && (
              <div><span className="stat-label">Released</span> {data.genius.releaseDate}</div>
            )}
            {data.genius.writers.length > 0 && (
              <div><span className="stat-label">Writers</span> {data.genius.writers.join(", ")}</div>
            )}
            {data.genius.producers.length > 0 && (
              <div><span className="stat-label">Producers</span> {data.genius.producers.join(", ")}</div>
            )}
          </div>
        )}
      </div>

      {/* full lyrics (accurate, whole-song, from Genius) */}
      {data.fullLyrics && (
        <div className="xray-lyricsheet">
          <div className="xray-lyricsheet-head">
            <span className="stat-label">Lyrics</span>
            <span className="muted" style={{ fontSize: 11 }}>full song · Genius</span>
          </div>
          <div className="xray-lyricsheet-body">{renderLyrics(data.fullLyrics)}</div>
        </div>
      )}

      {/* Stem Lab (Demucs) — opt-in, it's GPU-heavy */}
      <div style={{ marginTop: 18 }}>
        {!showStems ? (
          <button className="btn" onClick={() => setShowStems(true)}>
            🎛️ Separate stems (Demucs) — solo vocals/drums/bass, melody & groove
          </button>
        ) : (
          <StemLab previewUrl={previewUrl} title={title} artist={artist} />
        )}
      </div>
    </div>
  );
}

// Render Genius lyrics: [Section] tags become labels, blank lines become gaps.
function renderLyrics(text: string) {
  return text.split("\n").map((line, i) => {
    const t = line.trim();
    if (!t) return <div key={i} className="ly-gap" />;
    if (/^\[.*\]$/.test(t)) return <div key={i} className="ly-section">{t.replace(/^\[|\]$/g, "")}</div>;
    return <div key={i} className="ly-line">{t}</div>;
  });
}

function Stat({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
}) {
  return (
    <div className="xray-stat">
      <div className="stat-label">{label}</div>
      <div className="xray-stat-value">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {sub && <div className="xray-stat-sub">{sub}</div>}
    </div>
  );
}
