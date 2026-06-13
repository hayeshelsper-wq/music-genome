"use client";

import { useEffect, useRef, useState } from "react";
import { ArtistRef } from "@/lib/types";

interface DimScore {
  label: string;
  target: string;
  achieved: string;
  score: number;
  detail?: string;
}
interface Result {
  prompt: string;
  reference: { label: string; artist?: string; kind: string };
  scorecard: { overall: number; dims: DimScore[]; clap: number | null };
  clip: string; // data URL
}
interface UploadItem {
  id: string;
  title: string;
  key?: string;
  tempo?: number;
}

function scoreColor(s: number): string {
  if (s >= 75) return "var(--influence)";
  if (s >= 45) return "var(--root)";
  return "var(--descendant)";
}

export default function GenomeStudio() {
  const [mode, setMode] = useState<"artist" | "track">("artist");
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ArtistRef[]>([]);
  const [picked, setPicked] = useState<{ kind: string; id?: string; mbid?: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch("/api/uploads")
      .then((r) => r.json())
      .then((d) => setUploads(d.items || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (mode !== "artist" || q.trim().length < 2) {
      setHits([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const d = await r.json();
        setHits(d.artists || []);
      } catch {
        /* ignore */
      }
    }, 350);
  }, [q, mode]);

  async function generate() {
    if (!picked || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    setStage(
      picked.kind === "artist"
        ? "Reading the artist's DNA + analyzing a reference track…"
        : "Reading the track's DNA…"
    );
    // Nudge the staged copy along so the long GPU wait feels alive.
    const t1 = setTimeout(() => setStage("Generating audio on the GPU (MusicGen)…"), 2500);
    const t2 = setTimeout(() => setStage("Verifying — measuring the generated clip…"), 30000);
    try {
      const res = await fetch("/api/studio/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source:
            picked.kind === "artist"
              ? { kind: "artist", mbid: picked.mbid }
              : { kind: "track", id: picked.id },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `failed (${res.status})`);
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      setBusy(false);
      setStage("");
    }
  }

  return (
    <div className="studio">
      <div className="studio-head">
        <h2>The Genome Studio</h2>
        <p className="muted">
          Pick a source, and the studio reads its measured DNA — tempo, key,
          timbre, instrumentation — assembles a generation prompt, synthesizes a
          clip on the GPU, then runs that clip back through the same analysis to
          score how close it landed. Analyze → generate → <strong>verify</strong>.
        </p>
      </div>

      <div className="studio-pick">
        <div className="studio-tabs">
          <button
            className={`studio-tab ${mode === "artist" ? "on" : ""}`}
            onClick={() => { setMode("artist"); setPicked(null); }}
          >
            In the DNA of an artist
          </button>
          <button
            className={`studio-tab ${mode === "track" ? "on" : ""}`}
            onClick={() => { setMode("track"); setPicked(null); }}
          >
            From a library track
          </button>
        </div>

        {mode === "artist" ? (
          <div className="studio-search">
            <input
              className="search-input"
              placeholder="Search an artist — Radiohead, Aphex Twin…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {hits.length > 0 && (
              <div className="results">
                {hits.map((a) => (
                  <div
                    key={a.mbid}
                    className="result-row"
                    onClick={() => {
                      setPicked({ kind: "artist", mbid: a.mbid, label: a.name });
                      setHits([]);
                      setQ(a.name);
                    }}
                  >
                    <strong>{a.name}</strong>
                    {a.disambiguation && <span className="muted"> — {a.disambiguation}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="studio-uploads">
            {uploads.length === 0 && <p className="muted">No tracks in your library yet.</p>}
            {uploads.map((u) => (
              <button
                key={u.id}
                className={`studio-upload ${picked?.id === u.id ? "on" : ""}`}
                onClick={() => setPicked({ kind: "track", id: u.id, label: u.title })}
              >
                <strong>{u.title}</strong>
                <span className="muted">
                  {[u.key, u.tempo ? `${Math.round(u.tempo)} BPM` : ""].filter(Boolean).join(" · ")}
                </span>
              </button>
            ))}
          </div>
        )}

        <button
          className="btn studio-go"
          disabled={!picked || busy}
          onClick={generate}
        >
          {busy ? "Working…" : picked ? `🧬 Generate in the DNA of ${picked.label}` : "Pick a source"}
        </button>
        {busy && stage && (
          <div className="studio-stage muted">
            <span className="spinner" /> &nbsp;{stage}
          </div>
        )}
        {error && <div className="studio-error">⚠️ {error}</div>}
      </div>

      {result && (
        <div className="studio-result">
          <div className="studio-score">
            <div
              className="studio-score-ring"
              style={{ ["--c" as string]: scoreColor(result.scorecard.overall) }}
            >
              <span className="studio-score-num">{result.scorecard.overall}</span>
              <span className="studio-score-lbl">DNA match</span>
            </div>
            <div className="studio-clip">
              <div className="muted" style={{ marginBottom: 6 }}>
                Generated in the DNA of <strong>{result.reference.label}</strong>
                {result.reference.artist ? ` — ${result.reference.artist}` : ""}
              </div>
              <audio controls src={result.clip} style={{ width: "100%" }} />
              <details className="studio-prompt">
                <summary>generation prompt</summary>
                <code>{result.prompt}</code>
              </details>
            </div>
          </div>

          <table className="studio-table">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Target</th>
                <th>Generated</th>
                <th>Match</th>
              </tr>
            </thead>
            <tbody>
              {result.scorecard.dims.map((d) => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  <td>{d.target}</td>
                  <td>{d.achieved}</td>
                  <td>
                    <div className="studio-bar-wrap">
                      <div
                        className="studio-bar"
                        style={{ width: `${d.score}%`, background: scoreColor(d.score) }}
                      />
                      <span>{d.score}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn-mini ghost" disabled={busy} onClick={generate}>
            ↻ Generate again
          </button>
        </div>
      )}
    </div>
  );
}
