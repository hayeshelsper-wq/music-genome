"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface StemData {
  stems: Record<string, string>;
  melody: {
    contour: (number | null)[];
    topNotes: string[];
    voicedFraction: number;
    fingerprint?: {
      rangeLow: string;
      rangeHigh: string;
      rangeSemitones: number;
      register: string;
      vibrato: string;
      breathiness: string;
    } | null;
  };
  groove: { tempo: number; hitsPerSec: number; onsets: number[] };
  karaoke: { start: number; end: number; text: string; source: string }[];
  error?: string;
}

// fixed display order + colors
const STEMS = [
  { key: "vocals", label: "Vocals", color: "#ffd166" },
  { key: "drums", label: "Drums", color: "#ef476f" },
  { key: "bass", label: "Bass", color: "#5b8def" },
  { key: "other", label: "Other", color: "#06d6a0" },
];

export default function StemLab({
  previewUrl,
  title,
  artist,
}: {
  previewUrl: string;
  title: string;
  artist: string;
}) {
  const [data, setData] = useState<StemData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [solo, setSolo] = useState<string | null>(null);

  const audios = useRef<Record<string, HTMLAudioElement | null>>({});

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    setPlaying(false);
    setSolo(null);
    setMuted({});
    (async () => {
      try {
        const url = `/api/track/stems?previewUrl=${encodeURIComponent(
          previewUrl
        )}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`;
        const res = await fetch(url);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "failed");
        if (alive) setData(json);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "failed");
      }
    })();
    return () => {
      alive = false;
      Object.values(audios.current).forEach((a) => a?.pause());
    };
  }, [previewUrl, title, artist]);

  // apply mute/solo to each element
  useEffect(() => {
    for (const { key } of STEMS) {
      const el = audios.current[key];
      if (el) el.muted = solo ? key !== solo : !!muted[key];
    }
  }, [muted, solo, data]);

  const master = () => audios.current["vocals"];

  async function togglePlay() {
    const els = STEMS.map((s) => audios.current[s.key]).filter(Boolean) as HTMLAudioElement[];
    if (playing) {
      els.forEach((a) => a.pause());
      setPlaying(false);
    } else {
      const t = master()?.currentTime ?? 0;
      els.forEach((a) => (a.currentTime = t)); // resync before starting
      await Promise.all(els.map((a) => a.play().catch(() => {})));
      setPlaying(true);
    }
  }

  function seek(t: number) {
    STEMS.forEach((s) => {
      const el = audios.current[s.key];
      if (el) el.currentTime = t;
    });
    setTime(t);
  }

  if (error)
    return (
      <div className="stemlab">
        <p className="muted">
          Couldn’t separate stems: {error}
          <br />
          <span style={{ fontSize: 12 }}>(needs the Python audio service running with demucs)</span>
        </p>
      </div>
    );

  if (!data)
    return (
      <div className="stemlab">
        <div className="xray-loading">
          <span className="spinner" />
          <div>
            <strong>Separating stems with Demucs…</strong>
            <div className="muted" style={{ fontSize: 13 }}>
              splitting vocals / drums / bass / other on the GPU, then analyzing
              the isolated vocal melody & drum groove. ~15–30s, then instant.
            </div>
          </div>
        </div>
      </div>
    );

  const activeLine = data.karaoke.findIndex((k) => time >= k.start && time < k.end);

  return (
    <div className="stemlab">
      {/* hidden synced audio elements */}
      {STEMS.map((s) =>
        data.stems[s.key] ? (
          <audio
            key={s.key}
            ref={(el) => {
              audios.current[s.key] = el;
            }}
            src={data.stems[s.key]}
            preload="auto"
            onLoadedMetadata={(e) => {
              if (s.key === "vocals") setDuration(e.currentTarget.duration || 0);
            }}
            onTimeUpdate={(e) => {
              if (s.key === "vocals") setTime(e.currentTarget.currentTime);
            }}
            onEnded={() => {
              if (s.key === "vocals") {
                setPlaying(false);
                seek(0);
              }
            }}
          />
        ) : null
      )}

      <div className="stemlab-head">
        <h3>🎛️ Stem Lab — {title}</h3>
        <span className="muted" style={{ fontSize: 12 }}>Demucs source separation</span>
      </div>

      {/* transport */}
      <div className="stemlab-transport">
        <button className="stem-play" onClick={togglePlay}>
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          className="stem-seek"
          type="range"
          min={0}
          max={duration || 30}
          step={0.05}
          value={time}
          onChange={(e) => seek(parseFloat(e.target.value))}
        />
        <span className="stem-time">
          {time.toFixed(1)}s
          {solo && <span className="stem-soloing"> · solo: {solo}</span>}
        </span>
      </div>

      {/* stem rows */}
      <div className="stem-rows">
        {STEMS.map((s) => {
          const isSolo = solo === s.key;
          const isMuted = solo ? !isSolo : !!muted[s.key];
          return (
            <div className={`stem-row${isMuted ? " off" : ""}`} key={s.key}>
              <span className="stem-dot" style={{ background: s.color }} />
              <span className="stem-name">{s.label}</span>
              <div className="stem-btns">
                <button
                  className={`stem-toggle${isSolo ? " on" : ""}`}
                  onClick={() => setSolo(isSolo ? null : s.key)}
                >
                  Solo
                </button>
                <button
                  className={`stem-toggle${muted[s.key] && !solo ? " on" : ""}`}
                  onClick={() => setMuted((m) => ({ ...m, [s.key]: !m[s.key] }))}
                  disabled={!!solo}
                >
                  Mute
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* per-stem analysis */}
      <div className="stem-analysis">
        <div className="stem-card">
          <div className="stat-label" style={{ color: "#ffd166" }}>Vocal melody (isolated)</div>
          <MelodyViz contour={data.melody.contour} />
          <div className="stat-sub">
            notes: {data.melody.topNotes.join(" · ")} · {Math.round(data.melody.voicedFraction * 100)}% voiced
          </div>
          {data.melody.fingerprint && (
            <div className="vocal-fp">
              <span className="vfp">
                range{" "}
                <b>
                  {data.melody.fingerprint.rangeLow}–{data.melody.fingerprint.rangeHigh}
                </b>{" "}
                ({data.melody.fingerprint.rangeSemitones} st)
              </span>
              <span className="vfp">{data.melody.fingerprint.register}</span>
              <span className="vfp">{data.melody.fingerprint.vibrato}</span>
              <span className="vfp">{data.melody.fingerprint.breathiness}</span>
            </div>
          )}
        </div>
        <div className="stem-card">
          <div className="stat-label" style={{ color: "#ef476f" }}>Drum groove (isolated)</div>
          <GrooveViz onsets={data.groove.onsets} duration={duration || 30} time={time} />
          <div className="stat-sub">
            {data.groove.tempo} BPM · {data.groove.hitsPerSec} hits/sec
          </div>
        </div>
      </div>

      {/* karaoke */}
      {data.karaoke.length > 0 && (
        <div className="stem-karaoke">
          <div className="stat-label">Karaoke — Genius text, Whisper-on-vocal timing</div>
          <div className="karaoke-lines">
            {data.karaoke.map((k, i) => (
              <div
                key={i}
                className={`karaoke-line${i === activeLine ? " active" : ""}`}
                onClick={() => seek(k.start)}
              >
                {k.text}
                {k.source === "whisper" && <span className="karaoke-src"> ~heard</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MelodyViz({ contour }: { contour: (number | null)[] }) {
  const vals = contour.filter((v): v is number => v != null);
  const min = Math.min(...vals, 100);
  const max = Math.max(...vals, 400);
  const w = 100;
  const h = 40;
  // build segments (break on null/unvoiced gaps)
  const segs: string[] = [];
  let cur: string[] = [];
  contour.forEach((v, i) => {
    if (v == null) {
      if (cur.length) segs.push(cur.join(" "));
      cur = [];
    } else {
      const x = (i / (contour.length - 1)) * w;
      const y = h - ((v - min) / (max - min || 1)) * h;
      cur.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
  });
  if (cur.length) segs.push(cur.join(" "));
  return (
    <svg className="melody-svg" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {segs.map((pts, i) => (
        <polyline key={i} points={pts} fill="none" stroke="#ffd166" strokeWidth="1.2" />
      ))}
    </svg>
  );
}

function GrooveViz({ onsets, duration, time }: { onsets: number[]; duration: number; time: number }) {
  return (
    <div className="groove-strip">
      {onsets.map((t, i) => (
        <span
          key={i}
          className="groove-tick"
          style={{ left: `${(t / duration) * 100}%`, opacity: t <= time ? 1 : 0.4 }}
        />
      ))}
      <span className="groove-playhead" style={{ left: `${(time / duration) * 100}%` }} />
    </div>
  );
}
