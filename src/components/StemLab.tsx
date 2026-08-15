"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PianoRoll, { RollNote } from "./PianoRoll";

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
  const [roll, setRoll] = useState<RollNote[] | null>(null);
  const [rollOpen, setRollOpen] = useState(false); // collapsed by default
  const [rollBusy, setRollBusy] = useState(false);
  const [rollError, setRollError] = useState<string | null>(null);

  // "Extract anything" (SAM Audio) — extra stem rows in the same synced clock.
  const [extras, setExtras] = useState<{ key: string; label: string; text: string }[]>([]);
  const [extraText, setExtraText] = useState("");
  const [extraBusy, setExtraBusy] = useState(false);
  const [extraStatus, setExtraStatus] = useState("");
  const [extraError, setExtraError] = useState<string | null>(null);
  const [span, setSpan] = useState<[number, number] | null>(null);
  const spanDrag = useRef<{ startFrac: number; moved: boolean } | null>(null);
  const spanBarRef = useRef<HTMLDivElement | null>(null);

  // Esc clears the span selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSpan(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function spanFrac(clientX: number): number {
    const el = spanBarRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  }

  function onSpanDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    spanDrag.current = { startFrac: spanFrac(e.clientX), moved: false };
  }
  function onSpanMove(e: React.PointerEvent) {
    if (!spanDrag.current) return;
    const f = spanFrac(e.clientX);
    const { startFrac } = spanDrag.current;
    if (Math.abs(f - startFrac) > 0.01) {
      spanDrag.current.moved = true;
      const dur = durationRef.current || 30;
      setSpan([Math.min(startFrac, f) * dur, Math.max(startFrac, f) * dur]);
    }
  }
  function onSpanUp() {
    if (spanDrag.current && !spanDrag.current.moved) setSpan(null); // plain click clears
    spanDrag.current = null;
  }

  async function addExtraBuffer(key: string, url: string) {
    const ctx = ctxRef.current;
    if (!ctx) throw new Error("audio not ready");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`audio fetch ${res.status}`);
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    buffersRef.current[key] = buf;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    g.gain.value = solo ? 0 : 1;
    gainsRef.current[key] = g;
    if (buf.duration > durationRef.current) {
      durationRef.current = buf.duration;
      setDuration(buf.duration);
    }
    if (playing) await startPlayback(posRef.current); // join the running clock
  }

  async function extract(text: string, spanSel: [number, number] | null) {
    const trimmed = text.trim();
    if (!trimmed || extraBusy) return;
    setExtraBusy(true);
    setExtraError(null);
    setExtraStatus("Extracting with SAM Audio…");
    try {
      // Poll through the cold-GPU 202 (warming) phase.
      for (let attempt = 0; attempt < 30; attempt++) {
        const res = await fetch("/api/track/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            previewUrl,
            text: trimmed,
            ...(spanSel ? { spanStart: spanSel[0], spanEnd: spanSel[1] } : {}),
          }),
        });
        const j = await res.json();
        if (res.status === 202 && j.warming) {
          setExtraStatus("The extraction GPU is cold — warming it up…");
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        if (!res.ok || j.error) throw new Error(j.error || `failed (${res.status})`);
        const key = `x:${trimmed}:${Date.now()}`;
        await addExtraBuffer(key, j.url);
        setExtras((prev) => [...prev, { key, label: `✨ ${trimmed} (AI-extracted)`, text: trimmed }]);
        setExtraText("");
        setSpan(null);
        return;
      }
      throw new Error("GPU still warming — try again in a minute");
    } catch (e) {
      setExtraError(e instanceof Error ? e.message : "extraction failed");
    } finally {
      setExtraBusy(false);
      setExtraStatus("");
    }
  }

  function removeExtra(key: string) {
    delete buffersRef.current[key];
    try {
      gainsRef.current[key]?.disconnect();
    } catch {}
    delete gainsRef.current[key];
    setExtras((prev) => prev.filter((x) => x.key !== key));
    setSolo((s) => (s === key ? null : s));
    if (playing) startPlayback(posRef.current);
  }

  async function loadRoll() {
    setRollOpen(true);
    if (roll || rollBusy) return;
    setRollBusy(true);
    setRollError(null);
    try {
      const res = await fetch("/api/track/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ previewUrl, artist, title, mode: "melody" }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `failed (${res.status})`);
      setRoll(j.notes || []);
    } catch (e) {
      setRollError(e instanceof Error ? e.message : "transcription failed");
    } finally {
      setRollBusy(false);
    }
  }

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
    setExtras([]);
    setSpan(null);
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

  // mute/solo → gain (covers the four Demucs stems AND any AI extractions —
  // everything registered in gainsRef participates in the same solo/mute logic)
  useEffect(() => {
    for (const key of Object.keys(gainsRef.current)) {
      const g = gainsRef.current[key];
      if (!g) continue;
      const active = solo ? key === solo : !muted[key];
      g.gain.value = active ? 1 : 0;
    }
  }, [muted, solo, ready, extras]);

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
    for (const key of Object.keys(buffersRef.current)) {
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
        {extras.map((x) => {
          const isSolo = solo === x.key;
          const isMuted = solo ? !isSolo : !!muted[x.key];
          return (
            <div className={`stem-row extra${isMuted ? " off" : ""}`} key={x.key}>
              <span className="stem-dot" style={{ background: "#c792ea" }} />
              <span className="stem-name">{x.label}</span>
              <div className="stem-btns">
                <button
                  className={`stem-toggle${isSolo ? " on" : ""}`}
                  onClick={() => setSolo(isSolo ? null : x.key)}
                >
                  Solo
                </button>
                <button
                  className={`stem-toggle${muted[x.key] && !solo ? " on" : ""}`}
                  onClick={() => setMuted((m) => ({ ...m, [x.key]: !m[x.key] }))}
                  disabled={!!solo}
                >
                  Mute
                </button>
                <button
                  className="stem-toggle"
                  title="Re-run this extraction"
                  onClick={() => {
                    removeExtra(x.key);
                    extract(x.text, span);
                  }}
                >
                  ↻
                </button>
                <button
                  className="stem-toggle"
                  title="Remove"
                  onClick={() => removeExtra(x.key)}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Extract anything (SAM Audio) */}
      <div className="extract-row">
        <div className="stat-label">✨ Extract anything <span className="muted">(SAM Audio — AI separation)</span></div>
        {/* Suggested prompts — pre-seeded in the extraction cache for the
            showcase tracks, so these come back instantly even on a cold GPU. */}
        <div className="extract-suggestions">
          {["the drums", "the bass line", "the lead vocal"].map((s) => (
            <button
              key={s}
              className="tag-chip soft"
              disabled={extraBusy || !ready}
              onClick={() => extract(s, span)}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="extract-controls">
          <input
            className="search-input"
            placeholder="Describe a sound — the tambourine, crowd noise, the guitar solo…"
            value={extraText}
            onChange={(e) => setExtraText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") extract(extraText, span);
            }}
            disabled={extraBusy}
          />
          <button
            className="btn-mini"
            disabled={extraBusy || !extraText.trim() || !ready}
            onClick={() => extract(extraText, span)}
          >
            {extraBusy ? "…" : "Extract"}
          </button>
        </div>
        <div
          ref={spanBarRef}
          className="extract-span-bar"
          title="Drag to limit the extraction to a time span (Esc clears)"
          onPointerDown={onSpanDown}
          onPointerMove={onSpanMove}
          onPointerUp={onSpanUp}
        >
          {span && duration > 0 && (
            <div
              className="extract-span-sel"
              style={{
                left: `${(span[0] / duration) * 100}%`,
                width: `${((span[1] - span[0]) / duration) * 100}%`,
              }}
            />
          )}
          <div
            className="extract-span-playhead"
            style={{ left: `${duration ? (time / duration) * 100 : 0}%` }}
          />
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {span
            ? `span ${span[0].toFixed(1)}s – ${span[1].toFixed(1)}s (Esc to clear)`
            : "optional: drag the strip above to focus a time span"}
        </div>
        {extraBusy && extraStatus && (
          <div className="muted" style={{ fontSize: 12 }}>
            <span className="spinner" /> &nbsp;{extraStatus}
          </div>
        )}
        {extraError && (
          <div className="muted" style={{ fontSize: 12 }}>⚠️ {extraError}</div>
        )}
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
          {!rollOpen ? (
            <button className="stem-toggle" style={{ marginTop: 8 }} onClick={loadRoll}>
              ♪ Piano roll (transcribed notes)
            </button>
          ) : rollBusy ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              <span className="spinner" /> transcribing…
            </div>
          ) : rollError ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>⚠️ {rollError}</div>
          ) : (
            roll && (
              <div style={{ marginTop: 8 }}>
                <PianoRoll
                  notes={roll}
                  durationSec={duration || Math.max(1, ...roll.map((n) => n.e))}
                  currentTime={time}
                />
              </div>
            )
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
