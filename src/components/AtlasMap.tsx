"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface MapTrack {
  id: string;
  title: string;
  artist: string;
  year: number;
  genre: string;
  x: number;
  y: number;
  previewUrl: string;
  image: string | null;
}
interface MapData { generatedAt: number; count: number; tracks: MapTrack[] }

interface UploadItem { id: string; title: string }
interface Placed { x: number; y: number; title: string; neighbors: { title: string; artist: string; similarity: number }[] }

// One hue per genre (matches scripts/build-music-map.ts genre labels).
const GENRE_COLORS: Record<string, string> = {
  Roots: "#c9a227",
  Rock: "#ef476f",
  "Soul/Funk": "#ff9f1c",
  "Punk/Metal": "#9b5de5",
  "Disco/Electronic": "#00bbf9",
  "Hip-Hop": "#f15bb5",
  Pop: "#fee440",
  "Indie/Alt": "#06d6a0",
  Grunge: "#8d99ae",
  "R&B": "#5b8def",
};
const colorFor = (g: string) => GENRE_COLORS[g] || "#9a9ab0";

const W = 960, H = 600, PAD = 34;
const px = (x: number) => PAD + x * (W - 2 * PAD);
const py = (y: number) => PAD + (1 - y) * (H - 2 * PAD);

export default function AtlasMap() {
  const [data, setData] = useState<MapData | null>(null);
  const [err, setErr] = useState("");
  const [year, setYear] = useState(2025);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<MapTrack | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [placing, setPlacing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    fetch("/music-map.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("map not built yet"))))
      .then((d: MapData) => setData(d))
      .catch((e) => setErr(e.message));
    fetch("/api/uploads").then((r) => r.json()).then((d) => setUploads(d.items || [])).catch(() => {});
  }, []);

  const minYear = useMemo(
    () => (data ? Math.min(...data.tracks.map((t) => t.year)) : 1950),
    [data]
  );

  // Time-lapse playback: sweep the year from min → 2025.
  function play() {
    if (!data) return;
    if (playing) { setPlaying(false); if (raf.current) cancelAnimationFrame(raf.current); return; }
    setPlaying(true);
    let y = minYear;
    setYear(minYear);
    const start = performance.now();
    const DURATION = 11000;
    const span = 2025 - minYear;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      y = Math.round(minYear + t * span);
      setYear(y);
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    raf.current = requestAnimationFrame(tick);
  }
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  function playPreview(t: MapTrack) {
    setSel(t);
    const a = audioRef.current;
    if (a) { a.src = t.previewUrl; a.play().catch(() => {}); }
  }

  async function placeTrack(uploadId: string) {
    if (!uploadId) { setPlaced(null); return; }
    setPlacing(true); setPlaced(null);
    try {
      const r = await fetch("/api/atlas/place", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId }),
      });
      const d = await r.json();
      if (r.ok) setPlaced(d); else setErr(d.error || "placement failed");
    } finally { setPlacing(false); }
  }

  const genresPresent = useMemo(() => {
    if (!data) return [];
    const set = new Set(data.tracks.map((t) => t.genre));
    return Object.keys(GENRE_COLORS).filter((g) => set.has(g));
  }, [data]);

  const visibleCount = data ? data.tracks.filter((t) => t.year <= year).length : 0;

  return (
    <div className="atlas">
      <div className="atlas-head">
        <h2>The Living Map of Music</h2>
        <p className="muted">
          Every dot is a landmark track, placed by how it actually <em>sounds</em>
          {" "}(CLAP audio embeddings, projected to 2D). Scrub the years to watch
          the sonic landscape fill in — and drop one of your own tracks to see
          where it lands in music history.
        </p>
      </div>

      {err && <div className="atlas-error">⚠️ {err}</div>}

      <div className="atlas-controls">
        <button className="btn-mini" onClick={play}>{playing ? "⏸ Pause" : "▶ Play decades"}</button>
        <input
          className="atlas-slider"
          type="range" min={minYear} max={2025} value={year}
          onChange={(e) => { setYear(Number(e.target.value)); setPlaying(false); if (raf.current) cancelAnimationFrame(raf.current); }}
        />
        <span className="atlas-year">{year}</span>
        <span className="muted atlas-count">{visibleCount} tracks</span>
      </div>

      <div className="atlas-stage">
        <svg viewBox={`0 0 ${W} ${H}`} className="atlas-svg" preserveAspectRatio="xMidYMid meet">
          {data?.tracks.map((t) => {
            const on = t.year <= year;
            return (
              <g
                key={t.id}
                className={`atlas-pt ${on ? "on" : ""} ${sel?.id === t.id ? "sel" : ""}`}
                transform={`translate(${px(t.x)},${py(t.y)})`}
                onClick={() => on && playPreview(t)}
              >
                <circle r={sel?.id === t.id ? 9 : 6} fill={colorFor(t.genre)} />
                {sel?.id === t.id && <circle r={13} className="atlas-pt-ring" fill="none" stroke={colorFor(t.genre)} />}
              </g>
            );
          })}
          {placed && (
            <g transform={`translate(${px(placed.x)},${py(placed.y)})`} className="atlas-you">
              <circle r={10} fill="#fff" />
              <circle r={18} fill="none" stroke="#fff" className="atlas-you-ring" />
              <text y={-22} textAnchor="middle" className="atlas-you-label">YOU</text>
            </g>
          )}
        </svg>

        {sel && (
          <div className="atlas-card">
            {sel.image && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={sel.image} alt={sel.title} />
            )}
            <div>
              <div className="atlas-card-title">{sel.title}</div>
              <div className="muted">{sel.artist} · {sel.year}</div>
              <span className="atlas-card-genre" style={{ color: colorFor(sel.genre) }}>{sel.genre}</span>
            </div>
          </div>
        )}
      </div>

      <div className="atlas-legend">
        {genresPresent.map((g) => (
          <span key={g}><i style={{ background: colorFor(g) }} /> {g}</span>
        ))}
      </div>

      <div className="atlas-place">
        <span className="stat-label">📍 Drop your own track onto the map</span>
        {uploads.length === 0 ? (
          <p className="muted">Upload a track first to place it here.</p>
        ) : (
          <select className="atlas-select" disabled={placing} onChange={(e) => placeTrack(e.target.value)} defaultValue="">
            <option value="">{placing ? "Placing…" : "Choose a track from your library…"}</option>
            {uploads.map((u) => <option key={u.id} value={u.id}>{u.title}</option>)}
          </select>
        )}
        {placed && (
          <div className="atlas-place-result">
            <strong>{placed.title}</strong> lands nearest to:{" "}
            {placed.neighbors.map((n, i) => (
              <span key={i}>{i > 0 ? ", " : ""}{n.artist} – {n.title} <span className="muted">({Math.round(n.similarity * 100)}%)</span></span>
            ))}
          </div>
        )}
      </div>

      <audio ref={audioRef} hidden />
    </div>
  );
}
