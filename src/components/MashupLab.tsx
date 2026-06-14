"use client";

import { useEffect, useRef, useState } from "react";

interface CatTrack { id: string; title: string; artist: string; year: number; previewUrl: string }
interface MashResult {
  audio: string;
  a_tempo: number; b_tempo: number;
  a_key: string; b_key: string;
  stretch_rate: number; semitone_shift: number;
  duration_sec: number;
}

export default function MashupLab() {
  const [cat, setCat] = useState<CatTrack[]>([]);
  const [aId, setAId] = useState("");
  const [bId, setBId] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<MashResult | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetch("/music-map.json")
      .then((r) => r.json())
      .then((d) => setCat((d.tracks || []).sort((a: CatTrack, b: CatTrack) => a.artist.localeCompare(b.artist))))
      .catch(() => setError("catalog unavailable"));
  }, []);

  const A = cat.find((t) => t.id === aId);
  const B = cat.find((t) => t.id === bId);

  async function suggestBed() {
    if (!aId) return;
    setSuggesting(true);
    try {
      const r = await fetch(`/api/mashup/match?id=${encodeURIComponent(aId)}`);
      const d = await r.json();
      const top = (d.matches || []).find((m: { id: string }) => m.id !== aId);
      if (top) setBId(top.id);
    } finally { setSuggesting(false); }
  }

  async function generate() {
    if (!A || !B || busy) return;
    setBusy(true); setError(""); setResult(null);
    setStage("Separating both tracks with Demucs (vocals / drums / bass / other)…");
    const t1 = setTimeout(() => setStage("Conforming the acapella — time-stretch + pitch-shift to the bed…"), 30000);
    const t2 = setTimeout(() => setStage("Mixing the mashup…"), 55000);
    try {
      const res = await fetch("/api/mashup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aUrl: A.previewUrl, bUrl: B.previewUrl }),
      });
      const data = await res.json();
      if (!res.ok || data.error) setError(data.error || `failed (${res.status})`);
      else { setResult(data); setTimeout(() => audioRef.current?.play().catch(() => {}), 100); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      clearTimeout(t1); clearTimeout(t2); setBusy(false); setStage("");
    }
  }

  const opt = (t: CatTrack) => `${t.artist} — ${t.title} (${t.year})`;

  return (
    <div className="mashup">
      <div className="mashup-head">
        <h2>Mashup Lab</h2>
        <p className="muted">
          Take the <strong>vocals</strong> from one track and the
          {" "}<strong>instrumental</strong> from another. We separate both with
          Demucs, then conform the acapella to the bed — time-stretched to its
          tempo and pitch-shifted to its key — and mix them into one clip.
        </p>
      </div>

      <div className="mashup-decks">
        <div className="mashup-deck a">
          <div className="mashup-deck-label">🎤 Vocals from</div>
          <select className="mashup-select" value={aId} onChange={(e) => setAId(e.target.value)} disabled={busy}>
            <option value="">Choose a track…</option>
            {cat.map((t) => <option key={t.id} value={t.id}>{opt(t)}</option>)}
          </select>
          {A && <audio className="mashup-preview" controls src={A.previewUrl} preload="none" />}
        </div>

        <div className="mashup-plus">+</div>

        <div className="mashup-deck b">
          <div className="mashup-deck-label">🥁 Instrumental from</div>
          <select className="mashup-select" value={bId} onChange={(e) => setBId(e.target.value)} disabled={busy}>
            <option value="">Choose a track…</option>
            {cat.map((t) => <option key={t.id} value={t.id}>{opt(t)}</option>)}
          </select>
          {A && (
            <button className="btn-mini ghost mashup-suggest" onClick={suggestBed} disabled={suggesting || busy}>
              {suggesting ? "…" : "✨ Suggest a compatible bed"}
            </button>
          )}
          {B && <audio className="mashup-preview" controls src={B.previewUrl} preload="none" />}
        </div>
      </div>

      <button className="btn-solid mashup-go" disabled={!A || !B || busy} onClick={generate}>
        {busy ? "Working…" : "🎛️ Make the mashup"}
      </button>
      {busy && stage && <div className="mashup-stage muted"><span className="spinner" /> &nbsp;{stage}</div>}
      {error && <div className="mashup-error">⚠️ {error}</div>}

      {result && A && B && (
        <div className="mashup-result">
          <div className="mashup-result-title">
            🎧 <strong>{A.artist}</strong> vocals over <strong>{B.artist}</strong> instrumental
          </div>
          <audio ref={audioRef} controls src={result.audio} className="mashup-out" />
          <table className="mashup-table">
            <tbody>
              <tr><td>Acapella ({A.title})</td><td>{result.a_tempo} BPM · {result.a_key}</td></tr>
              <tr><td>Bed ({B.title})</td><td>{result.b_tempo} BPM · {result.b_key}</td></tr>
              <tr><td>Conform applied</td><td>
                {result.stretch_rate !== 1 ? `time-stretched ${Math.round((result.stretch_rate - 1) * 100)}%` : "no stretch"}
                {result.semitone_shift !== 0 ? `, pitch-shifted ${result.semitone_shift > 0 ? "+" : ""}${result.semitone_shift} semitones` : ", no pitch shift"}
              </td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
