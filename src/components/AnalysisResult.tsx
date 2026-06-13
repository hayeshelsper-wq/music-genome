"use client";

import { CSSProperties, useEffect, useState } from "react";

interface SonicHit {
  id: string;
  title: string;
  key?: string;
  tempo?: number;
  distance?: number;
}

/** "Sonic Twins" — library tracks that sound closest (CLAP audio→audio KNN). */
function SonicTwins({ trackId }: { trackId: string }) {
  const [hits, setHits] = useState<SonicHit[] | null>(null);
  useEffect(() => {
    let alive = true;
    setHits(null);
    fetch(`/api/uploads/${trackId}/twins`)
      .then((r) => r.json())
      .then((j) => alive && setHits(j.hits || []))
      .catch(() => alive && setHits([]));
    return () => {
      alive = false;
    };
  }, [trackId]);
  if (!hits || hits.length === 0) return null;
  return (
    <div className="sonic-twins" style={{ marginTop: 14 }}>
      <div className="stat-label">
        🧬 Sonic Twins{" "}
        <span className="muted">(tracks that actually sound like this)</span>
      </div>
      <div className="twin-row">
        {hits.map((h) => (
          <div key={h.id} className="twin-chip">
            <span className="twin-name">{h.title}</span>
            <span className="twin-meta muted">
              {[h.key, h.tempo ? `${h.tempo} BPM` : ""].filter(Boolean).join(" · ")}
              {typeof h.distance === "number" &&
                ` · ${Math.round((1 - h.distance) * 100)}%`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface Section {
  start: number;
  end: number;
  intensity: number;
  label: string;
}
export interface Features {
  duration_sec: number;
  tempo_bpm: number;
  tempo_feel: string;
  key: string;
  key_confidence: number;
  harmonic_emphasis: string[];
  chords?: string[];
  chords_roman?: string[];
  progression?: string | null;
  brightness: string;
  texture: string;
  density: string;
  dynamics: string;
  energy_shape: string;
}
export interface TagItem {
  label: string;
  prob: number;
}
export interface TagSet {
  instruments?: TagItem[];
  genres?: TagItem[];
  moods?: TagItem[];
  voice?: { vocal: boolean; prob: number };
}
export interface AnalysisData {
  features: Features | null;
  chromagram?: string | null;
  sections?: Section[];
  tags?: TagSet | null;
  breakdown?: string; // upload-flow field name
  review?: string; // stored (Firestore) field name
  flamingo?: string;
  flamingoStatus?: string; // "complete" | "pending"
  model?: string;
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** The full-song analysis view — shared by the upload flow and the saved
 *  library. Pass `audioSrc` to show a player for the stored audio. */
export default function AnalysisResult({
  data,
  audioSrc,
  trackId,
}: {
  data: AnalysisData;
  audioSrc?: string;
  trackId?: string;
}) {
  const f = data.features;
  if (!f) return null;
  const sections = data.sections || [];
  const review = data.breakdown ?? data.review; // upload vs. stored field name
  const totalDur = sections.length
    ? sections[sections.length - 1].end
    : f.duration_sec || 1;

  return (
    <div className="up-result">
      {audioSrc && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio className="lib-audio" controls preload="none" src={audioSrc} />
      )}

      <div className="xray-stats">
        <div className="xray-stat">
          <div className="stat-label">Key</div>
          <div className="xray-stat-value">{f.key}</div>
          <div className="xray-stat-sub">conf {f.key_confidence}</div>
        </div>
        <div className="xray-stat">
          <div className="stat-label">Tempo</div>
          <div className="xray-stat-value">
            {f.tempo_bpm}
            <span className="stat-unit">BPM</span>
          </div>
          <div className="xray-stat-sub">{f.tempo_feel}</div>
        </div>
        <div className="xray-stat">
          <div className="stat-label">Length</div>
          <div className="xray-stat-value">{fmt(f.duration_sec)}</div>
        </div>
        <div className="xray-stat">
          <div className="stat-label">Texture</div>
          <div className="xray-stat-value">{f.texture}</div>
        </div>
        <div className="xray-stat">
          <div className="stat-label">Brightness</div>
          <div className="xray-stat-value">{f.brightness}</div>
        </div>
        <div className="xray-stat">
          <div className="stat-label">Dynamics</div>
          <div className="xray-stat-value">{f.dynamics}</div>
        </div>
      </div>

      {data.tags &&
        (data.tags.instruments?.length || data.tags.voice || data.tags.genres?.length) && (
          <div className="xray-tags">
            <div className="stat-label">
              📊 Detected{" "}
              <span className="muted">
                (supervised tagger — instruments, genre &amp; mood, measured not guessed)
              </span>
            </div>
            {data.tags.voice && (
              <div className="tag-line">
                <span className="tag-key">Vocals</span>
                <span className={`tag-chip ${data.tags.voice.vocal ? "yes" : "no"}`}>
                  {data.tags.voice.vocal ? "🎤 vocal" : "🎻 instrumental"}
                </span>
              </div>
            )}
            {!!data.tags.instruments?.length && (
              <div className="tag-line">
                <span className="tag-key">Instruments</span>
                {data.tags.instruments.map((t, i) => (
                  <span key={i} className="tag-chip">
                    {t.label}
                  </span>
                ))}
              </div>
            )}
            {!!data.tags.genres?.length && (
              <div className="tag-line">
                <span className="tag-key">Genre</span>
                {data.tags.genres.map((t, i) => (
                  <span key={i} className="tag-chip soft">
                    {t.label}
                  </span>
                ))}
              </div>
            )}
            {!!data.tags.moods?.length && (
              <div className="tag-line">
                <span className="tag-key">Mood</span>
                {data.tags.moods.map((t, i) => (
                  <span key={i} className="tag-chip soft">
                    {t.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

      {sections.length > 0 && (
        <div className="up-structure">
          <div className="stat-label">Structure &amp; energy map</div>
          <div className="struct-bar">
            {sections.map((s, i) => (
              <div
                key={i}
                className="struct-seg"
                style={
                  {
                    width: `${((s.end - s.start) / totalDur) * 100}%`,
                    "--i": s.intensity,
                  } as CSSProperties
                }
                title={`${s.label} · ${fmt(s.start)}–${fmt(s.end)} · intensity ${Math.round(
                  s.intensity * 100
                )}%`}
              >
                <span className="struct-label">{s.label}</span>
                <span className="struct-time">{fmt(s.start)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {f.chords && f.chords.length > 0 && (
        <div className="xray-chords">
          <div className="stat-label">
            Chord progression <span className="muted">(estimated)</span>
          </div>
          <div className="chord-row">
            {f.chords.map((c, i) => (
              <span key={i} className="chord-chip">
                <span className="chord-name">{c}</span>
                {f.chords_roman?.[i] && (
                  <span className="chord-roman">{f.chords_roman[i]}</span>
                )}
              </span>
            ))}
          </div>
          {f.progression && <div className="chord-prog">↳ {f.progression}</div>}
        </div>
      )}

      {data.chromagram && (
        <div className="xray-chroma" style={{ marginTop: 14 }}>
          <div className="stat-label">Chromagram (pitch content over time)</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={data.chromagram} alt="chromagram" />
        </div>
      )}

      {data.flamingoStatus === "pending" && !data.flamingo && (
        <div className="flamingo-pending">
          <span className="spinner" />
          <span>
            🦩 The GPU was cold, so Music Flamingo is spinning up to analyze the
            audio and upgrade this review with its read. This can take a few
            minutes on a cold start — it updates automatically, no need to
            refresh (and it resumes if you come back to it in your library).
          </span>
        </div>
      )}

      {data.flamingo && (
        <details className="xray-flamingo" style={{ marginTop: 14 }}>
          <summary>
            🦩 Music Flamingo heard this{" "}
            <span className="muted">
              (NVIDIA audio-LLM, on a representative section — informed but
              fallible)
            </span>
          </summary>
          <div className="xray-flamingo-body">{data.flamingo}</div>
        </details>
      )}

      {review && (
        <div className="xray-breakdown" style={{ marginTop: 16 }}>
          <div className="stat-label">📝 The Review</div>
          <p>{review}</p>
          {data.model && (
            <div className="xray-model muted">
              review by {data.model} · grounded in full-song measurements
              {data.flamingo ? " + Flamingo" : ""}
            </div>
          )}
        </div>
      )}

      {trackId && <SonicTwins trackId={trackId} />}
    </div>
  );
}
