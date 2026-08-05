"use client";

// Hum-to-Genome: record a hum → see it as notes → see where it lands on the
// Living Map → hear it produced in a real style. Four vertical steps.

import { useEffect, useState } from "react";
import HumRecorder from "@/components/HumRecorder";
import PianoRoll, { RollNote } from "@/components/PianoRoll";
import ScorecardView, { ScorecardData, scoreColor } from "@/components/ScorecardView";
import { ArtistRef } from "@/lib/types";

interface MapPoint {
  x: number;
  y: number;
  genre?: string;
}
interface HumResult {
  humId: string;
  notes: RollNote[];
  notesQuantized: RollNote[];
  bpm: number | null;
  map: { x: number; y: number; neighbors: { title: string; artist: string; similarity: number }[] } | null;
  renderUrl: string;
}
interface Production {
  producedId: string;
  url: string;
  prompt: string;
  engine: string;
  referenceLabel: string;
  scorecard: ScorecardData | null;
  melodicFidelity: number | null;
}
interface LoraItem {
  id: string;
  label: string;
  status: string;
}

const GENRE_COLORS: Record<string, string> = {
  rock: "#ef476f", pop: "#ffd166", "hip-hop": "#c792ea", electronic: "#06d6a0",
  jazz: "#5b8def", soul: "#ff9f68", folk: "#9ccc65", country: "#d4a373",
  classical: "#b0bec5", reggae: "#ffe066",
};

export default function HumPage() {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [hum, setHum] = useState<HumResult | null>(null);
  const [quantized, setQuantized] = useState(false);
  const [mapPts, setMapPts] = useState<MapPoint[]>([]);
  const [loras, setLoras] = useState<LoraItem[]>([]);
  const [producing, setProducing] = useState<string | null>(null);
  const [productions, setProductions] = useState<Production[]>([]);
  const [verify, setVerify] = useState(true);

  useEffect(() => {
    fetch("/music-map.json")
      .then((r) => r.json())
      .then((d) => setMapPts(d.tracks || []))
      .catch(() => {});
    fetch("/api/loras")
      .then((r) => (r.ok ? r.json() : { loras: [] }))
      .then((d) => setLoras((d.loras || []).filter((l: LoraItem) => l.status === "ready")))
      .catch(() => {});
  }, []);

  async function onRecorded(blob: Blob, mime: string) {
    setProcessing(true);
    setError("");
    setHum(null);
    setProductions([]);
    try {
      const fd = new FormData();
      const ext = mime.includes("mp4") ? "m4a" : "webm";
      fd.append("file", blob, `hum.${ext}`);
      const res = await fetch("/api/hum", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `failed (${res.status})`);
      setHum(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "hum processing failed");
    } finally {
      setProcessing(false);
    }
  }

  async function produce(style: { mbid?: string; artistName?: string; loraId?: string }) {
    if (!hum || producing) return;
    const label = style.artistName || style.loraId || "style";
    setProducing(label);
    setError("");
    try {
      let mbid = style.mbid;
      // Neighbor chips only carry a name — resolve it to an mbid first.
      if (!mbid && style.artistName) {
        const r = await fetch(`/api/search?q=${encodeURIComponent(style.artistName)}`);
        const d = await r.json();
        mbid = (d.artists as ArtistRef[] | undefined)?.[0]?.mbid;
        if (!mbid) throw new Error(`couldn't resolve "${style.artistName}"`);
      }
      const res = await fetch("/api/hum/produce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          humId: hum.humId,
          ...(style.loraId ? { loraId: style.loraId, engine: "acestep" } : { styleMbid: mbid, engine: "musicgen-melody" }),
          verify,
        }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `failed (${res.status})`);
      setProductions((prev) => [j, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "production failed");
    } finally {
      setProducing(null);
    }
  }

  const notes = hum ? (quantized && hum.notesQuantized.length ? hum.notesQuantized : hum.notes) : [];

  return (
    <div className="hum-page">
      <div className="studio-head">
        <h2>🎙️ Hum to Genome</h2>
        <p className="muted">
          Hum or whistle a melody. The genome transcribes it to notes, drops it on
          the Living Map by how it sounds, and can produce it in the style of any
          artist in the graph — or one of your trained voices.
        </p>
      </div>

      {/* Step 1 — record */}
      <section className="hum-step">
        <h3><span className="hum-step-num">1</span> Record</h3>
        <HumRecorder onRecorded={onRecorded} />
        {processing && (
          <div className="muted" style={{ marginTop: 8 }}>
            <span className="spinner" /> &nbsp;Transcribing your melody (pyin) + rendering it…
          </div>
        )}
        {error && <div className="studio-error">⚠️ {error}</div>}
      </section>

      {/* Step 2 — your melody */}
      {hum && (
        <section className="hum-step">
          <h3><span className="hum-step-num">2</span> Your melody</h3>
          <div className="hum-roll-controls">
            <span className="muted">
              {hum.notes.length} notes{hum.bpm ? ` · ~${Math.round(hum.bpm)} BPM` : ""}
            </span>
            {hum.notesQuantized.length > 0 && (
              <button className="btn-mini ghost" onClick={() => setQuantized((q) => !q)}>
                {quantized ? "showing: snapped to 1/8 grid" : "showing: raw timing"} — toggle
              </button>
            )}
          </div>
          <PianoRoll notes={notes} durationSec={Math.max(1, ...notes.map((n) => n.e))} />
          <audio controls src={hum.renderUrl} preload="none" style={{ width: "100%", marginTop: 8 }} />
          <div className="muted" style={{ fontSize: 12 }}>↑ the clean piano render the genome heard</div>
        </section>
      )}

      {/* Step 3 — on the map */}
      {hum?.map && (
        <section className="hum-step">
          <h3><span className="hum-step-num">3</span> On the map</h3>
          <svg viewBox="0 0 1000 240" preserveAspectRatio="xMidYMid slice" className="map-preview-svg hum-map">
            {mapPts.map((p, i) => (
              <circle key={i} cx={20 + p.x * 960} cy={20 + (1 - p.y) * 200} r={4}
                fill={GENRE_COLORS[p.genre || ""] || "#9a9ab0"} opacity={0.55} />
            ))}
            <g>
              <circle cx={20 + hum.map.x * 960} cy={20 + (1 - hum.map.y) * 200} r={11}
                fill="none" stroke="#ffffff" strokeWidth={2} />
              <circle cx={20 + hum.map.x * 960} cy={20 + (1 - hum.map.y) * 200} r={5.5} fill="#ffffff" />
            </g>
          </svg>
          <div className="hum-neighbors">
            {hum.map.neighbors.map((n, i) => (
              <span key={i} className="tag-chip">
                {n.artist} — {n.title} · {Math.round(n.similarity * 100)}%
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Step 4 — hear it produced */}
      {hum && (
        <section className="hum-step">
          <h3><span className="hum-step-num">4</span> Hear it produced</h3>
          <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            Pick a style — your melody stays, the production changes.
          </div>
          <label className="hum-verify">
            <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
            score fidelity (did it keep my melody?)
          </label>
          <div className="hum-styles">
            {(hum.map?.neighbors || []).map((n, i) => (
              <button
                key={i}
                className="showcase-card hum-style-card"
                disabled={!!producing}
                onClick={() => produce({ artistName: n.artist })}
              >
                <div className="showcase-card-title">{n.artist}</div>
                <div className="showcase-card-artist muted">nearest neighbor · MusicGen-melody</div>
              </button>
            ))}
            {loras.map((l) => (
              <button
                key={l.id}
                className="showcase-card hum-style-card"
                disabled={!!producing}
                onClick={() => produce({ loraId: l.id })}
              >
                <div className="showcase-card-title">🎤 {l.label}</div>
                <div className="showcase-card-artist muted">your voice · ACE-Step</div>
              </button>
            ))}
          </div>
          {producing && (
            <div className="muted" style={{ marginTop: 8 }}>
              <span className="spinner" /> &nbsp;Producing with {producing}… (GPU generation, ~30–60s)
            </div>
          )}
          <div className="hum-productions">
            {productions.map((p) => (
              <div key={p.producedId} className="opt-card">
                <div className="opt-card-head">
                  <strong>{p.referenceLabel}</strong>
                  <span className="muted">{p.engine}</span>
                  {p.melodicFidelity != null && (
                    <span className="opt-dna" style={{ ["--c" as string]: scoreColor(p.melodicFidelity * 100) }}>
                      {Math.round(p.melodicFidelity * 100)}% melody kept
                    </span>
                  )}
                </div>
                <audio controls src={p.url} preload="none" style={{ width: "100%" }} />
                {p.scorecard && <ScorecardView dims={p.scorecard.dims} />}
                <details className="studio-prompt">
                  <summary>generation prompt</summary>
                  <code>{p.prompt}</code>
                </details>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
