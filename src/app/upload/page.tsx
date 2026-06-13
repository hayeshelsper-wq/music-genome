"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AnalysisResult, { AnalysisData } from "@/components/AnalysisResult";
import { pollFlamingoBackfill } from "@/lib/flamingoBackfill";

interface Result extends AnalysisData {
  id?: string | null;
  title: string;
}

export default function UploadPage() {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false); // record persisted, analysis in flight
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File) {
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) {
      setError("File is over 30 MB — try an MP3/M4A or a shorter export.");
      return;
    }
    setError(null);
    setResult(null);
    setSaved(false);
    setBusy(true);
    try {
      // 1) Upload the file + create the library record FIRST (fast). It's now
      //    safely in your library even if you navigate away mid-analysis.
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", file.name.replace(/\.[^.]+$/, ""));
      const up = await fetch("/api/upload", { method: "POST", body: fd });
      const u = await up.json();
      if (!up.ok || !u.id) throw new Error(u.error || "upload failed");
      setSaved(true);

      // 2) Run the analysis (resumable; reads the audio back from storage).
      const an = await fetch(`/api/uploads/${u.id}/analyze`, { method: "POST" });
      const j = await an.json();
      if (!an.ok) throw new Error(j.error || "analysis failed");
      setResult({ ...j, id: u.id, title: u.title || j.title });

      // Cold GPU → Flamingo pending: poll the backfill (the first attempt warms
      // the GPU, a follow-up lands the read) and merge it in when it arrives.
      if (u.id && j.flamingoStatus === "pending") {
        pollFlamingoBackfill(u.id, (bf) =>
          setResult((prev) =>
            prev
              ? {
                  ...prev,
                  flamingo: bf.flamingo,
                  breakdown: bf.breakdown || prev.breakdown,
                  flamingoStatus: "complete",
                }
              : prev
          )
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="up-page">
      <div className="up-hero">
        <div className="up-hero-inner">
          <div className="up-topnav">
            <Link href="/" className="up-navlink">
              ← home
            </Link>
            <Link href="/library" className="up-navlink lib">
              your library →
            </Link>
          </div>
          <span className="up-eyebrow">Studio</span>
          <h1>🎚️ Analyze your own track</h1>
          <p>
            Drop an audio file (MP3 / M4A / WAV) for the full-song X-ray — key,
            tempo, estimated chord progression, a structure &amp; energy map, and a
            grounded review. No 30-second-preview ceiling. Saved to your library so
            you can come back to it.
          </p>
        </div>
      </div>

      <div className="up-body">
        {!result && (
          <div
            className={`up-drop${drag ? " over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const fl = e.dataTransfer.files?.[0];
              if (fl) handleFile(fl);
            }}
            onClick={() => !busy && inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept="audio/*,.mp3,.m4a,.wav,.flac,.aiff"
              hidden
              onChange={(e) => {
                const fl = e.target.files?.[0];
                if (fl) handleFile(fl);
              }}
            />
            {busy ? (
              <>
                <span className="spinner" />
                <div>
                  <strong>
                    {saved
                      ? "Saved to your library ✓ — analyzing the whole track…"
                      : "Uploading…"}
                  </strong>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {saved
                      ? "full-song analysis + Flamingo — usually ~30–90s (a touch longer the first time after the GPU has been idle). It keeps going in your library if you navigate away."
                      : "saving your file to your library first…"}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 32 }}>⬆️</div>
                <strong>Drop an audio file here</strong>
                <div className="muted" style={{ fontSize: 13 }}>
                  or click to browse · up to 30 MB
                </div>
              </>
            )}
          </div>
        )}

        {error && (
          <div className="notice" style={{ marginTop: 16 }}>
            Error: {error}
          </div>
        )}

        {result && result.features && (
          <div style={{ marginTop: 8 }}>
            <div className="xray-head">
              <h3>🔬 {result.title}</h3>
              <button
                className="btn"
                onClick={() => {
                  setResult(null);
                  setError(null);
                }}
              >
                Analyze another
              </button>
            </div>
            {result.id && (
              <div className="muted" style={{ margin: "0 0 10px" }}>
                ✓ Saved to your{" "}
                <Link href="/library" className="lib-link">
                  library
                </Link>
              </div>
            )}
            <AnalysisResult data={result} trackId={result.id ?? undefined} />
          </div>
        )}
      </div>
    </div>
  );
}
