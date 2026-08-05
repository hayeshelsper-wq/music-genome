"use client";

// Hum/whistle recorder: raw-ish capture (no echo cancellation / noise
// suppression — they eat pitched humming), a live level meter, and a hard 15s
// stop. Hands the finished Blob (+ its container mime) to the parent.

import { useEffect, useRef, useState } from "react";
import { pickRecorderMime } from "@/lib/recorderMime";

const MAX_SEC = 15;

export default function HumRecorder({
  onRecorded,
}: {
  onRecorded: (blob: Blob, mime: string) => void;
}) {
  const [state, setState] = useState<"idle" | "recording" | "unsupported" | "denied">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const rafRef = useRef<number | null>(null);
  const startedAt = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    return () => stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopAll() {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    try {
      recRef.current?.state !== "inactive" && recRef.current?.stop();
    } catch {}
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }

  async function start() {
    if (typeof MediaRecorder === "undefined") {
      setState("unsupported");
      return;
    }
    const mime = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t));
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch {
      setState("denied");
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recRef.current = rec;
    const usedMime = rec.mimeType || mime || "audio/webm";
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: usedMime });
      setState("idle");
      setLevel(0);
      if (blob.size > 0) onRecorded(blob, usedMime);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };

    // Level meter.
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const meter = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
      setLevel(peak);
      setElapsed((Date.now() - startedAt.current) / 1000);
      rafRef.current = requestAnimationFrame(meter);
    };

    startedAt.current = Date.now();
    setElapsed(0);
    setState("recording");
    rec.start();
    rafRef.current = requestAnimationFrame(meter);
    stopTimer.current = setTimeout(() => stop(), MAX_SEC * 1000); // hard stop
  }

  function stop() {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    try {
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
    } catch {}
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }

  if (state === "unsupported") {
    return <p className="muted">This browser can’t record audio (no MediaRecorder).</p>;
  }
  if (state === "denied") {
    return (
      <p className="muted">
        Microphone access was blocked — allow it in the browser and try again.{" "}
        <button className="btn-mini ghost" onClick={() => setState("idle")}>retry</button>
      </p>
    );
  }

  return (
    <div className="hum-recorder">
      {state === "idle" ? (
        <button className="btn" onClick={start}>
          🎙️ Record a hum <span className="muted">(up to {MAX_SEC}s)</span>
        </button>
      ) : (
        <div className="hum-recording">
          <button className="btn" onClick={stop}>
            ⏹ Stop ({Math.max(0, MAX_SEC - elapsed).toFixed(0)}s left)
          </button>
          <div className="hum-meter">
            <div
              className="hum-meter-fill"
              style={{ width: `${Math.min(100, level * 140)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
