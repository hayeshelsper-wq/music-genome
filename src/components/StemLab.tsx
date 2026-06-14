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
  const [ready, setReady] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [solo, setSolo] = useState<string | null>(null);

  // All stems play through ONE Web Audio clock so they stay sample-accurately in
  // sync (four independent <audio> elements drift apart). Each stem gets its own
  // gain node for mute/solo; sources are one-shot and tracked so we can stop them
  // all together at the end and reset — no element keeps looping on its own.
  const ctxRef = useRef<AudioContext | null>(null);
  const buffersRef = useRef<Record<string, AudioBuffer>>({});
  const gainsRef = useRef<Record<string, GainNode>>({});
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const startInfo = useRef<{ ctxStart: number; offset: number }>({ ctxStart: 0, offset: 0 });
  const posRef = useRef(0);
  const durationRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // fetch the separated stems + analysis
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
    };
  }, [previewUrl, title, artist]);

  function stopSources() {
    sourcesRef.current.forEach((s) => {
      try { s.onended = null; s.stop(); } catch {}
      try { s.disconnect(); } catch {}
    });
    sourcesRef.current = [];
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

  // decode every stem into an AudioBuffer once the URLs arrive
  useEffect(() => {
    if (!data?.stems) return;
    let alive = true;
    setReady(false);
    posRef.current = 0;
    setTime(0);
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    ctxRef.current = ctx;
    (async () => {
      try {
        const entries = STEMS.filter((s) => data.stems[s.key]);
        const buffers: Record<string, AudioBuffer> = {};
        const gains: Record<string, GainNode> = {};
        await Promise.all(
          entries.map(async (s) => {
            const res = await fetch(data.stems[s.key]);
            const ab = await res.arrayBuffer();
            const buf = await ctx.decodeAudioData(ab);
            if (!alive) return;
            buffers[s.key] = buf;
            const g = ctx.createGain();
            g.connect(ctx.destination);
            gains[s.key] = g;
          })
        );
        if (!alive) return;
        buffersRef.current = buffers;
        gainsRef.current = gains;
        const dur = Math.max(0, ...Object.values(buffers).map((b) => b.duration));
        durationRef.current = dur;
        setDuration(dur);
        setReady(true);
      } catch {
        if (alive) setError("could not load stem audio");
      }
    })();
    return () => {
      alive = false;
      stopSources();
      buffersRef.current = {};
      gainsRef.current = {};
      ctx.close().catch(() => {});
      ctxRef.current = null;
      setReady(false);
      setPlaying(false);
    };
  }, [data]);

  // mute/solo → gain
  useEffect(() => {
    for (const { key } of STEMS) {
      const g = gainsRef.current[key];
      if (!g) continue;
      const active = solo ? key === solo : !muted[key];
      g.gain.value = active ? 1 : 0;
    }
  }, [muted, solo, ready]);

  const tick = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const { ctxStart, offset } = startInfo.current;
    const dur = durationRef.current;
    const pos = offset + Math.max(0, ctx.currentTime - ctxStart);
    if (dur && pos >= dur) {
      // reached the end: stop everything, rewind, reset the button
      stopSources();
      posRef.current = 0;
      setTime(0);
      setPlaying(false);
      return;
    }
    posRef.current = pos;
    setTime(pos);
    rafRef.current = requestAnimationFrame(tick);
  };

  async function startPlayback(offset: number) {
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") await ctx.resume();
    stopSources();
    const startTime = ctx.currentTime + 0.06; // tiny lead so all sources fire together
    const srcs: AudioBufferSourceNode[] = [];
    for (const { key } of STEMS) {
      const buf = buffersRef.current[key];
      const g = gainsRef.current[key];
      if (!buf || !g) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(g);
      src.start(startTime, offset);
      srcs.push(src);
    }
    sourcesRef.current = srcs;
    startInfo.current = { ctxStart: startTime, offset };
    setPlaying(true);
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }

  async function togglePlay() {
    if (!ready) return;
    if (playing) {
      const ctx = ctxRef.current;
      if (ctx) {
        const { ctxStart, offset } = startInfo.current;
        posRef.current = Math.min(
          durationRef.current,
          offset + Math.max(0, ctx.currentTime - ctxStart)
        );
      }
      stopSources();
      setPlaying(false);
    } else {
      const from = posRef.current >= durationRef.current ? 0 : posRef.current;
      await startPlayback(from);
    }
  }

  function seek(t: number) {
    const dur = durationRef.current || t;
    const clamped = Math.max(0, Math.min(t, dur));
    posRef.current = clamped;
    setTime(clamped);
    if (playing) startPlayback(clamped); // restart all sources from the new offset
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
      <div className="stemlab-head">
        <h3>🎛️ Stem Lab — {title}</h3>
        <span className="muted" style={{ fontSize: 12 }}>Demucs source separation</span>
      </div>

      {/* transport */}
      <div className="stemlab-transport">
        <button
          className="stem-play"
          onClick={togglePlay}
          disabled={!ready}
          aria-label={playing ? "Pause" : "Play"}
          title={!ready ? "Loading stem audio…" : playing ? "Pause" : "Play"}
        >
          {!ready ? "…" : playing ? "❚❚" : "▶"}
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
