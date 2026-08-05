"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { diffWords } from "diff";
import { ArtistRef } from "@/lib/types";
import { streamNdjson } from "@/lib/ndjson";
import ScorecardView, { ScorecardData, scoreColor } from "./ScorecardView";

interface Result {
  prompt: string;
  promptSource?: "claude+flamingo" | "claude" | "template";
  promptModel?: string;
  referenceHeard?: boolean;
  reference: { label: string; artist?: string; kind: string };
  scorecard: ScorecardData;
  clip: string; // data URL
}

function promptSourceNote(r: Result): string | null {
  if (r.promptSource === "claude+flamingo")
    return "written by Claude from Music Flamingo's read of the track";
  if (r.promptSource === "claude") return "written by Claude from the measured DNA";
  return null;
}
interface UploadItem {
  id: string;
  title: string;
  key?: string;
  tempo?: number;
}

// One optimizer attempt as accumulated from the NDJSON stream (all fields
// arrive incrementally: attempt → audio → score → critique).
interface OptAttempt {
  i: number;
  prompt: string;
  promptSource: string;
  url?: string;
  scorecard?: ScorecardData;
  dnaMatch?: number;
  critique?: { analysis: string; changes: string[] };
}

interface RunSummary {
  id: string;
  createdAt: number;
  engine: string;
  referenceLabel: string;
  status: string;
  stopReason?: string;
  attemptCount: number;
  best: number;
}

interface LoraItem {
  id: string;
  label: string;
  status: "queued" | "training" | "ready" | "error";
  gcsPath: string;
  error?: string;
}

type OptStatus = "idle" | "running" | "done" | "error";

function PromptDiff({ prev, curr }: { prev: string | null; curr: string }) {
  if (!prev) return <code>{curr}</code>;
  const parts = diffWords(prev, curr);
  return (
    <code>
      {parts.map((p, i) =>
        p.added ? (
          <ins key={i} className="opt-ins">
            {p.value}
          </ins>
        ) : p.removed ? (
          <del key={i} className="opt-del">
            {p.value}
          </del>
        ) : (
          <span key={i}>{p.value}</span>
        )
      )}
    </code>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length === 0) return null;
  const W = 180;
  const H = 40;
  const pts = values
    .map((v, i) => {
      const x = values.length === 1 ? W / 2 : (i / (values.length - 1)) * (W - 8) + 4;
      const y = H - 4 - (Math.max(0, Math.min(100, v)) / 100) * (H - 8);
      return `${x},${y}`;
    })
    .join(" ");
  const last = values[values.length - 1];
  return (
    <svg
      className="opt-sparkline"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      aria-label={`DNA match per attempt: ${values.join(", ")}`}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={scoreColor(last)}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {values.map((v, i) => {
        const x = values.length === 1 ? W / 2 : (i / (values.length - 1)) * (W - 8) + 4;
        const y = H - 4 - (Math.max(0, Math.min(100, v)) / 100) * (H - 8);
        return <circle key={i} cx={x} cy={y} r="3" fill={scoreColor(v)} />;
      })}
    </svg>
  );
}

function statusChip(status: OptStatus, stopReason: string | null): { label: string; cls: string } {
  if (status === "running") return { label: "optimizing…", cls: "running" };
  if (status === "error") return { label: "stream failed", cls: "err" };
  if (status === "done") {
    const reason: Record<string, string> = {
      threshold: "hit the DNA threshold",
      plateau: "plateaued",
      max_iters: "attempt limit reached",
      critic_error: "critic failed — kept the best attempt",
    };
    return { label: reason[stopReason || ""] || "done", cls: "ok" };
  }
  return { label: "", cls: "" };
}

export default function GenomeStudio() {
  const searchParams = useSearchParams();
  const viewRunId = searchParams.get("run");

  const [mode, setMode] = useState<"artist" | "track">("artist");
  const [runMode, setRunMode] = useState<"oneshot" | "optimize">("oneshot");
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ArtistRef[]>([]);
  const [picked, setPicked] = useState<{ kind: string; id?: string; mbid?: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Optimize-mode state.
  const [attempts, setAttempts] = useState<OptAttempt[]>([]);
  const [optStatus, setOptStatus] = useState<OptStatus>("idle");
  const [stopReason, setStopReason] = useState<string | null>(null);
  const [bestAttempt, setBestAttempt] = useState<number | null>(null);
  const [optError, setOptError] = useState("");
  const [pastRuns, setPastRuns] = useState<RunSummary[]>([]);
  const [viewingRun, setViewingRun] = useState<{ label: string; engine: string } | null>(null);

  // Engine + voice (ACE-Step LoRA) selection.
  const [engine, setEngine] = useState<"musicgen" | "acestep">("musicgen");
  const [durationSec, setDurationSec] = useState(10);
  const [lyrics, setLyrics] = useState("");
  const [loras, setLoras] = useState<LoraItem[]>([]);
  const [voiceId, setVoiceId] = useState<string>("");
  const [voiceLabel, setVoiceLabel] = useState("");
  const [voiceUploads, setVoiceUploads] = useState<Set<string>>(new Set());
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState("");

  const acestepAvailable = true; // server rejects cleanly if ACESTEP_URL unset

  const refreshLoras = useCallback(() => {
    fetch("/api/loras")
      .then((r) => (r.ok ? r.json() : { loras: [] }))
      .then((d) => setLoras(d.loras || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/uploads")
      .then((r) => r.json())
      .then((d) => setUploads(d.items || []))
      .catch(() => {});
    fetch("/api/studio/runs")
      .then((r) => r.json())
      .then((d) => setPastRuns(d.runs || []))
      .catch(() => {});
    refreshLoras();
  }, [refreshLoras]);

  // Auto-refresh voices while any are queued/training.
  useEffect(() => {
    if (!loras.some((l) => l.status === "queued" || l.status === "training")) return;
    const t = setInterval(refreshLoras, 10_000);
    return () => clearInterval(t);
  }, [loras, refreshLoras]);

  // Engine switch resets the duration to that engine's sweet spot.
  useEffect(() => {
    setDurationSec(engine === "acestep" ? 60 : 10);
    if (engine !== "acestep") setVoiceId("");
  }, [engine]);

  async function trainVoice() {
    if (!voiceLabel.trim() || voiceUploads.size === 0 || voiceBusy) return;
    setVoiceBusy(true);
    setVoiceError("");
    try {
      const res = await fetch("/api/loras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: voiceLabel.trim(), uploadIds: [...voiceUploads] }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `failed (${res.status})`);
      setVoiceLabel("");
      setVoiceUploads(new Set());
      refreshLoras();
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : "training request failed");
    } finally {
      setVoiceBusy(false);
    }
  }

  // Read-only view of a past run (?run=<id>).
  useEffect(() => {
    if (!viewRunId) return;
    fetch(`/api/studio/runs?id=${encodeURIComponent(viewRunId)}`)
      .then((r) => r.json())
      .then((run) => {
        if (run.error) {
          setOptError(run.error);
          return;
        }
        setRunMode("optimize");
        setViewingRun({ label: run.referenceLabel, engine: run.engine });
        setAttempts(
          (run.attempts || []).map(
            (a: OptAttempt & { url?: string; critique?: string | null }) => ({
              i: a.i,
              prompt: a.prompt,
              promptSource: a.promptSource,
              url: a.url,
              scorecard: a.scorecard,
              dnaMatch: a.dnaMatch,
            })
          )
        );
        setOptStatus(run.status === "error" ? "error" : "done");
        setStopReason(run.stopReason || null);
        setBestAttempt(run.bestAttempt ?? null);
      })
      .catch(() => setOptError("could not load run"));
  }, [viewRunId]);

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
    const t1 = setTimeout(() => setStage("Listening with Music Flamingo + writing the prompt…"), 2500);
    const t2 = setTimeout(() => setStage("Generating audio on the GPU (MusicGen)…"), 7000);
    const t3 = setTimeout(() => setStage("Verifying — measuring the generated clip…"), 32000);
    try {
      const loraGcs = loras.find((l) => l.id === voiceId && l.status === "ready")?.gcsPath;
      const res = await fetch("/api/studio/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source:
            picked.kind === "artist"
              ? { kind: "artist", mbid: picked.mbid }
              : { kind: "track", id: picked.id },
          // Opt-in V2 params; the classic musicgen defaults send none of them.
          ...(engine === "acestep"
            ? {
                engine,
                durationSec,
                ...(lyrics.trim() ? { lyrics: lyrics.trim() } : {}),
                ...(loraGcs ? { loraGcs } : {}),
              }
            : durationSec !== 10
            ? { durationSec }
            : {}),
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
      clearTimeout(t3);
      setBusy(false);
      setStage("");
    }
  }

  const optimize = useCallback(async () => {
    if (!picked || busy) return;
    setBusy(true);
    setViewingRun(null);
    setOptError("");
    setAttempts([]);
    setStopReason(null);
    setBestAttempt(null);
    setOptStatus("running");

    const patchAttempt = (i: number, fn: (a: OptAttempt) => OptAttempt) =>
      setAttempts((prev) => prev.map((a) => (a.i === i ? fn(a) : a)));

    const loraGcs = loras.find((l) => l.id === voiceId && l.status === "ready")?.gcsPath;
    await streamNdjson(
      "/api/studio/optimize",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source:
            picked.kind === "artist"
              ? { kind: "artist", mbid: picked.mbid }
              : { kind: "track", id: picked.id },
          engine,
          durationSec,
          ...(engine === "acestep" && lyrics.trim() ? { lyrics: lyrics.trim() } : {}),
          ...(engine === "acestep" && loraGcs ? { loraGcs } : {}),
        }),
      },
      (obj) => {
        const ev = obj as Record<string, unknown> & { t?: string; i?: number };
        switch (ev.t) {
          case "run":
            break;
          case "attempt":
            setAttempts((prev) => [
              ...prev,
              {
                i: ev.i as number,
                prompt: String(ev.prompt || ""),
                promptSource: String(ev.promptSource || ""),
              },
            ]);
            break;
          case "audio":
            patchAttempt(ev.i as number, (a) => ({ ...a, url: String(ev.url || "") }));
            break;
          case "score":
            patchAttempt(ev.i as number, (a) => ({
              ...a,
              scorecard: ev.scorecard as ScorecardData,
              dnaMatch: ev.dnaMatch as number,
            }));
            break;
          case "critique":
            patchAttempt(ev.i as number, (a) => ({
              ...a,
              critique: {
                analysis: String(ev.analysis || ""),
                changes: Array.isArray(ev.changes) ? (ev.changes as string[]) : [],
              },
            }));
            break;
          case "done":
            setOptStatus("done");
            setStopReason(String(ev.stopReason || ""));
            setBestAttempt(typeof ev.bestAttempt === "number" ? ev.bestAttempt : null);
            break;
          case "error":
            setOptStatus("error");
            setOptError(String(ev.message || "optimize failed"));
            break;
        }
      },
      () => {
        setOptStatus((s) => (s === "running" ? "error" : s));
        setBusy(false);
        fetch("/api/studio/runs")
          .then((r) => r.json())
          .then((d) => setPastRuns(d.runs || []))
          .catch(() => {});
      },
      (e) => {
        setOptStatus("error");
        setOptError(e.message);
        setBusy(false);
      }
    );
  }, [picked, busy, engine, durationSec, lyrics, loras, voiceId]);

  const chip = statusChip(optStatus, stopReason);
  const dnaSeries = attempts
    .filter((a) => typeof a.dnaMatch === "number")
    .map((a) => a.dnaMatch as number);

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

        <div className="studio-tabs studio-mode">
          <button
            className={`studio-tab ${runMode === "oneshot" ? "on" : ""}`}
            onClick={() => setRunMode("oneshot")}
          >
            One shot
          </button>
          <button
            className={`studio-tab ${runMode === "optimize" ? "on" : ""}`}
            onClick={() => setRunMode("optimize")}
          >
            Optimize
          </button>
        </div>

        <div className="studio-engine">
          <label className="studio-engine-field">
            <span className="muted">Engine</span>
            <select
              value={engine}
              onChange={(e) => setEngine(e.target.value as "musicgen" | "acestep")}
            >
              <option value="musicgen">MusicGen — sketch (≤15s)</option>
              {acestepAvailable && (
                <option value="acestep">ACE-Step — full song w/ lyrics (≤120s)</option>
              )}
            </select>
          </label>
          <label className="studio-engine-field">
            <span className="muted">Duration: {durationSec}s</span>
            <input
              type="range"
              min={engine === "acestep" ? 10 : 4}
              max={engine === "acestep" ? 120 : 15}
              step={1}
              value={durationSec}
              onChange={(e) => setDurationSec(Number(e.target.value))}
            />
          </label>
          {engine === "acestep" && (
            <label className="studio-engine-field">
              <span className="muted">Voice</span>
              <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                <option value="">Base</option>
                {loras
                  .filter((l) => l.status === "ready")
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {engine === "acestep" && (
            <textarea
              className="studio-lyrics"
              placeholder="Lyrics (optional — leave blank and Claude writes original lyrics in the artist's style; instrumental = [inst])"
              value={lyrics}
              onChange={(e) => setLyrics(e.target.value)}
              rows={3}
            />
          )}
        </div>

        <button
          className="btn studio-go"
          disabled={!picked || busy}
          onClick={runMode === "optimize" ? optimize : generate}
        >
          {busy
            ? "Working…"
            : picked
            ? runMode === "optimize"
              ? `🔁 Optimize toward ${picked.label}`
              : `🧬 Generate in the DNA of ${picked.label}`
            : "Pick a source"}
        </button>
        {busy && runMode === "oneshot" && stage && (
          <div className="studio-stage muted">
            <span className="spinner" /> &nbsp;{stage}
          </div>
        )}
        {error && runMode === "oneshot" && <div className="studio-error">⚠️ {error}</div>}
      </div>

      {runMode === "optimize" && (optStatus !== "idle" || optError) && (
        <div className="opt-run">
          <div className="opt-strip">
            {viewingRun && (
              <span className="muted">
                Past run — <strong>{viewingRun.label}</strong> ({viewingRun.engine})
              </span>
            )}
            <Sparkline values={dnaSeries} />
            {chip.label && <span className={`opt-chip ${chip.cls}`}>{chip.label}</span>}
            {optStatus === "running" && <span className="spinner" />}
          </div>
          {optError && <div className="studio-error">⚠️ {optError}</div>}

          <div className="opt-attempts">
            {attempts.map((a, idx) => (
              <div
                key={a.i}
                className={`opt-card ${bestAttempt === a.i && optStatus === "done" ? "best" : ""}`}
              >
                <div className="opt-card-head">
                  <strong>Attempt {a.i + 1}</strong>
                  {typeof a.dnaMatch === "number" ? (
                    <span
                      className="opt-dna"
                      style={{ ["--c" as string]: scoreColor(a.dnaMatch) }}
                    >
                      {a.dnaMatch} DNA
                    </span>
                  ) : (
                    <span className="muted">
                      <span className="spinner" /> generating &amp; measuring…
                    </span>
                  )}
                  {bestAttempt === a.i && optStatus === "done" && (
                    <span className="opt-best-tag">★ best</span>
                  )}
                </div>
                <div className="opt-prompt">
                  <PromptDiff prev={idx > 0 ? attempts[idx - 1].prompt : null} curr={a.prompt} />
                </div>
                {a.url && <audio controls src={a.url} preload="none" style={{ width: "100%" }} />}
                {a.scorecard && <ScorecardView dims={a.scorecard.dims} />}
                {a.critique && (
                  <blockquote className="opt-critique">
                    <div>{a.critique.analysis}</div>
                    {a.critique.changes.length > 0 && (
                      <ul>
                        {a.critique.changes.map((c, j) => (
                          <li key={j}>{c}</li>
                        ))}
                      </ul>
                    )}
                  </blockquote>
                )}
              </div>
            ))}
            {optStatus === "running" && attempts.length === 0 && (
              <div className="muted">
                <span className="spinner" /> &nbsp;Reading the reference DNA + writing the first
                prompt…
              </div>
            )}
          </div>
        </div>
      )}

      {result && runMode === "oneshot" && (
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
                <summary>
                  generation prompt
                  {promptSourceNote(result) && (
                    <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                      · {promptSourceNote(result)}
                    </span>
                  )}
                </summary>
                <code>{result.prompt}</code>
              </details>
            </div>
          </div>

          <ScorecardView dims={result.scorecard.dims} />
          <button className="btn-mini ghost" disabled={busy} onClick={generate}>
            ↻ Generate again
          </button>
        </div>
      )}

      <div className="studio-voices">
        <h3>🎤 Voices <span className="muted">(ACE-Step LoRAs trained on your own uploads)</span></h3>
        {loras.length > 0 && (
          <div className="voice-list">
            {loras.map((l) => (
              <div key={l.id} className="voice-row">
                <strong>{l.label}</strong>
                <span className={`opt-chip ${l.status === "ready" ? "ok" : l.status === "error" ? "err" : "running"}`}>
                  {l.status}
                </span>
                {l.status === "error" && l.error && (
                  <span className="muted" style={{ fontSize: 12 }}>{l.error}</span>
                )}
              </div>
            ))}
          </div>
        )}
        <details className="voice-train">
          <summary>Train from my library</summary>
          <input
            className="search-input"
            placeholder="Voice name — e.g. 'my demos'"
            value={voiceLabel}
            onChange={(e) => setVoiceLabel(e.target.value)}
          />
          <div className="studio-uploads">
            {uploads.length === 0 && <p className="muted">No tracks in your library yet.</p>}
            {uploads.map((u) => (
              <button
                key={u.id}
                className={`studio-upload ${voiceUploads.has(u.id) ? "on" : ""}`}
                onClick={() =>
                  setVoiceUploads((prev) => {
                    const next = new Set(prev);
                    if (next.has(u.id)) next.delete(u.id);
                    else next.add(u.id);
                    return next;
                  })
                }
              >
                <strong>{u.title}</strong>
              </button>
            ))}
          </div>
          <button
            className="btn-mini"
            disabled={voiceBusy || !voiceLabel.trim() || voiceUploads.size === 0}
            onClick={trainVoice}
          >
            {voiceBusy ? "…" : `Train on ${voiceUploads.size} track${voiceUploads.size === 1 ? "" : "s"}`}
          </button>
          {voiceError && <div className="studio-error">⚠️ {voiceError}</div>}
          <p className="muted" style={{ fontSize: 12 }}>
            Training runs as a GPU job (~30–60 min). Only your own uploads can be
            used — never catalog previews.
          </p>
        </details>
      </div>

      {pastRuns.length > 0 && (
        <div className="studio-runs">
          <h3>Past runs</h3>
          {pastRuns.map((r) => (
            <a key={r.id} className="studio-run-row" href={`/studio?run=${r.id}`}>
              <strong>{r.referenceLabel}</strong>
              <span className="muted">
                {r.attemptCount} attempt{r.attemptCount === 1 ? "" : "s"} · best {r.best} ·{" "}
                {r.engine}
                {r.status === "error" ? " · ⚠️ error" : ""}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
