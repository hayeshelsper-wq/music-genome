"use client";

// Canvas piano roll for transcribed melodies. x = time, y = MIDI pitch
// (auto-ranged to the melody ±2 semitones). Click a note to hear a sine blip.

import { useCallback, useEffect, useRef } from "react";

export interface RollNote {
  p: number; // MIDI pitch
  s: number; // start (s)
  e: number; // end (s)
  v: number; // velocity
}

function midiToHz(p: number): number {
  return 440 * Math.pow(2, (p - 69) / 12);
}

export default function PianoRoll({
  notes,
  durationSec,
  currentTime,
  accent = "#ffd166",
}: {
  notes: RollNote[];
  durationSec: number;
  currentTime?: number;
  accent?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxAudioRef = useRef<AudioContext | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600;
    const cssH = canvas.clientHeight || 180;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);

    if (!notes.length || !durationSec) {
      g.fillStyle = "#9a9ab0";
      g.font = "12px system-ui";
      g.fillText("no notes", 10, 20);
      return;
    }

    const lo = Math.min(...notes.map((n) => n.p)) - 2;
    const hi = Math.max(...notes.map((n) => n.p)) + 2;
    const span = Math.max(1, hi - lo);
    const x = (t: number) => (t / durationSec) * cssW;
    const y = (p: number) => cssH - ((p - lo) / span) * cssH;
    const rowH = Math.max(3, cssH / span - 1);

    // Octave guide lines (C rows).
    g.strokeStyle = "rgba(154,154,176,0.15)";
    g.lineWidth = 1;
    for (let p = Math.ceil(lo / 12) * 12; p <= hi; p += 12) {
      g.beginPath();
      g.moveTo(0, y(p));
      g.lineTo(cssW, y(p));
      g.stroke();
    }

    for (const n of notes) {
      const nx = x(n.s);
      const nw = Math.max(2, x(n.e) - nx);
      const ny = y(n.p) - rowH / 2;
      const active =
        currentTime != null && currentTime >= n.s && currentTime < n.e;
      g.globalAlpha = 0.35 + 0.65 * Math.min(1, n.v / 110);
      g.fillStyle = active ? "#ffffff" : accent;
      g.beginPath();
      g.roundRect(nx, ny, nw, rowH, 2);
      g.fill();
    }
    g.globalAlpha = 1;

    if (currentTime != null && currentTime >= 0) {
      g.strokeStyle = "rgba(255,255,255,0.7)";
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x(currentTime), 0);
      g.lineTo(x(currentTime), cssH);
      g.stroke();
    }
  }, [notes, durationSec, currentTime, accent]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  const blip = useCallback((pitch: number) => {
    try {
      if (!ctxAudioRef.current) {
        ctxAudioRef.current = new AudioContext();
      }
      const ctx = ctxAudioRef.current;
      void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = midiToHz(pitch);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } catch {
      // audio blip is a nicety
    }
  }, []);

  const onClick = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !notes.length || !durationSec) return;
      const rect = canvas.getBoundingClientRect();
      const t = ((ev.clientX - rect.left) / rect.width) * durationSec;
      const py = ev.clientY - rect.top;
      const lo = Math.min(...notes.map((n) => n.p)) - 2;
      const hi = Math.max(...notes.map((n) => n.p)) + 2;
      const span = Math.max(1, hi - lo);
      const pitch = lo + (1 - py / rect.height) * span;
      // nearest note around the click
      let bestNote: RollNote | null = null;
      let bestDist = Infinity;
      for (const n of notes) {
        const inTime = t >= n.s - 0.05 && t <= n.e + 0.05;
        const d = Math.abs(n.p - pitch) + (inTime ? 0 : 5);
        if (d < bestDist) {
          bestDist = d;
          bestNote = n;
        }
      }
      if (bestNote && bestDist < 4) blip(bestNote.p);
    },
    [notes, durationSec, blip]
  );

  return (
    <canvas
      ref={canvasRef}
      className="piano-roll"
      style={{ width: "100%", height: 180, cursor: "pointer" }}
      onClick={onClick}
    />
  );
}
