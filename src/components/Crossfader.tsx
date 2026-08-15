"use client";

// Artist DNA Crossfader: two style anchors, one slider, live generated audio.
// Audio path: WS (audio-service proxy) → s16le PCM frames → AudioWorklet ring
// buffer at 48kHz. Slider updates stream as {type:"weight"} at ≤10Hz.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArtistRef } from "@/lib/types";

type Stage =
  | "picking"
  | "warming"
  | "connecting"
  | "buffering"
  | "live"
  | "ended"
  | "busy"
  | "error";

interface Anchor {
  mbid: string;
  name: string;
}

function proxyWsUrl(token: string): string {
  // The audio-service fronts the browser directly (same origin pattern as
  // /stemfiles): NEXT_PUBLIC_AUDIO_WS overrides; default local dev port 8000.
  const base =
    process.env.NEXT_PUBLIC_AUDIO_WS ||
    (typeof window !== "undefined" && window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1"
      ? "" // must be configured in prod
      : "ws://127.0.0.1:8000");
  if (!base) return "";
  return `${base}/mrt/session${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

export default function Crossfader({
  initialA,
  initialB,
}: {
  initialA?: Anchor | null;
  initialB?: Anchor | null;
}) {
  const [a, setA] = useState<Anchor | null>(initialA || null);
  const [b, setB] = useState<Anchor | null>(initialB || null);
  const [stage, setStage] = useState<Stage>("picking");
  const [status, setStatus] = useState("");
  const [weight, setWeight] = useState(0.5);
  const [buffered, setBuffered] = useState(0);
  const [underruns, setUnderruns] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const lastWeightSent = useRef(0);
  const startedPlayback = useRef(false);
  const chunkCount = useRef(0);

  const stopAll = useCallback(() => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "stop" }));
    } catch {}
    wsRef.current?.close();
    wsRef.current = null;
    nodeRef.current?.port.postMessage({ type: "reset" });
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    nodeRef.current = null;
    startedPlayback.current = false;
    chunkCount.current = 0;
  }, []);

  useEffect(() => () => stopAll(), [stopAll]);

  const start = useCallback(async () => {
    if (!a || !b) return;
    setStage("warming");
    setStatus("Waking the generator (first start can take a couple of minutes)…");
    setUnderruns(0);

    // iOS Safari only unmutes an AudioContext created/resumed INSIDE a user
    // gesture — do it synchronously here, before any await, or mobile playback
    // stays silently suspended forever.
    const ctx = new AudioContext({ sampleRate: 48000 });
    ctxRef.current = ctx;
    void ctx.resume();

    try {
      // 1) Warm the model (poll health until warm-ish; tolerate slow cold start).
      for (let i = 0; i < 20; i++) {
        try {
          const h = await fetch("/api/crossfade/health").then((r) => r.json());
          if (h.warm || h.loaded) break;
          if (h.error && !String(h.error).includes("warmup")) {
            throw new Error(String(h.error));
          }
        } catch (e) {
          if (i === 19) throw e;
        }
        await new Promise((r) => setTimeout(r, 4000));
      }

      // 2) Fetch anchors + token in parallel.
      setStatus("Reading both artists' DNA for style anchors…");
      const [anchorA, anchorB, tokenRes] = await Promise.all([
        fetch(`/api/crossfade/anchor?mbid=${a.mbid}&name=${encodeURIComponent(a.name)}`).then((r) => r.json()),
        fetch(`/api/crossfade/anchor?mbid=${b.mbid}&name=${encodeURIComponent(b.name)}`).then((r) => r.json()),
        fetch("/api/crossfade/token").then((r) => r.json()),
      ]);
      if (anchorA.error) throw new Error(`anchor A: ${anchorA.error}`);
      if (anchorB.error) throw new Error(`anchor B: ${anchorB.error}`);

      // 3) Audio pipeline (context already created in the gesture above).
      await ctx.audioWorklet.addModule("/worklets/pcm-player.js");
      const node = new AudioWorkletNode(ctx, "pcm-player", {
        outputChannelCount: [2],
      });
      node.connect(ctx.destination);
      nodeRef.current = node;
      node.port.onmessage = (e) => {
        if (e.data.type === "level") setBuffered(e.data.available / 48000);
        else if (e.data.type === "underrun") {
          setUnderruns(e.data.underruns);
          setBuffered(e.data.available / 48000);
        }
      };

      // 4) WebSocket.
      const url = proxyWsUrl(tokenRes.token || "");
      if (!url) throw new Error("audio WS endpoint not configured (NEXT_PUBLIC_AUDIO_WS)");
      setStage("connecting");
      setStatus("Connecting the live stream…");
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "init",
            a: { text: anchorA.text, ...(anchorA.audio_b64 ? { audio_b64: anchorA.audio_b64 } : {}) },
            b: { text: anchorB.text, ...(anchorB.audio_b64 ? { audio_b64: anchorB.audio_b64 } : {}) },
            weight,
          })
        );
        setStage("buffering");
        setStatus("Buffering the first chunks…");
      };
      ws.onmessage = async (ev) => {
        if (typeof ev.data === "string") {
          try {
            const m = JSON.parse(ev.data);
            if (m.type === "busy") {
              setStage("busy");
              setStatus("Another session is live — try again in a minute.");
            } else if (m.type === "error") {
              setStage("error");
              setStatus(m.message || "generator error");
            }
          } catch {}
          return;
        }
        const int16 = new Int16Array(ev.data as ArrayBuffer);
        const frames = int16.length / 2;
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          left[i] = int16[2 * i] / 32768;
          right[i] = int16[2 * i + 1] / 32768;
        }
        nodeRef.current?.port.postMessage({ type: "push", left, right }, [
          left.buffer,
          right.buffer,
        ]);
        chunkCount.current++;
        if (!startedPlayback.current && chunkCount.current >= 2) {
          startedPlayback.current = true;
          await ctxRef.current?.resume();
          setStage("live");
          setStatus("");
        }
      };
      ws.onclose = (ev) => {
        if (stage !== "error" && stage !== "busy") {
          setStage("ended");
          setStatus(ev.reason === "session_cap" ? "Session hit the 15-minute cap." : "Stream ended.");
        }
      };
      ws.onerror = () => {
        setStage("error");
        setStatus("Stream connection failed.");
      };
    } catch (e) {
      setStage("error");
      setStatus(e instanceof Error ? e.message : "failed to start");
      stopAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b, weight, stopAll]);

  // Slider → weight messages, throttled to 10Hz.
  const onWeight = (v: number) => {
    setWeight(v);
    const now = Date.now();
    if (now - lastWeightSent.current >= 100 && wsRef.current?.readyState === WebSocket.OPEN) {
      lastWeightSent.current = now;
      wsRef.current.send(JSON.stringify({ type: "weight", value: v }));
    }
  };

  const live = stage === "live" || stage === "buffering";

  return (
    <div className="crossfader">
      <div className="cf-pickers">
        <ArtistPicker label="Side A" value={a} onPick={setA} disabled={live} />
        <div className="cf-vs">🎚</div>
        <ArtistPicker label="Side B" value={b} onPick={setB} disabled={live} />
      </div>

      {!live && stage !== "warming" && stage !== "connecting" && (
        <button className="btn studio-go" disabled={!a || !b} onClick={start}>
          {a && b ? `▶ Morph ${a.name} ↔ ${b.name} live` : "Pick two artists"}
        </button>
      )}
      {(stage === "warming" || stage === "connecting") && (
        <div className="muted"><span className="spinner" /> &nbsp;{status}</div>
      )}
      {(stage === "ended" || stage === "error" || stage === "busy") && (
        <div className="cf-endcard">
          <div className="muted">{status}</div>
          <button className="btn-mini" onClick={() => { stopAll(); setStage("picking"); }}>
            ↻ Reconnect
          </button>
        </div>
      )}

      {live && a && b && (
        <div className="cf-live">
          <div className="cf-slider-row">
            <span className="cf-side">{a.name}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={weight}
              onChange={(e) => onWeight(parseFloat(e.target.value))}
              className="cf-slider"
            />
            <span className="cf-side">{b.name}</span>
          </div>
          <div className="cf-meta muted">
            {Math.round((1 - weight) * 100)}% {a.name} · {Math.round(weight * 100)}% {b.name}
            {" — "}
            {stage === "buffering" ? "buffering…" : `${buffered.toFixed(1)}s buffered`}
            {underruns > 0 && ` · ${underruns} dropouts`}
          </div>
          <button className="btn-mini ghost" onClick={() => { stopAll(); setStage("ended"); setStatus("Stopped."); }}>
            ⏹ Stop
          </button>
        </div>
      )}
    </div>
  );
}

function ArtistPicker({
  label,
  value,
  onPick,
  disabled,
}: {
  label: string;
  value: Anchor | null;
  onPick: (a: Anchor) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState(value?.name || "");
  const [hits, setHits] = useState<ArtistRef[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (disabled || q.trim().length < 2 || q === value?.name) {
      setHits([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const d = await r.json();
        setHits(d.artists || []);
      } catch {}
    }, 350);
  }, [q, disabled, value]);

  return (
    <div className="cf-picker">
      <div className="stat-label">{label}</div>
      <input
        className="search-input"
        placeholder="Search an artist…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        disabled={disabled}
      />
      {hits.length > 0 && (
        <div className="results">
          {hits.slice(0, 6).map((h) => (
            <div
              key={h.mbid}
              className="result-row"
              onClick={() => {
                onPick({ mbid: h.mbid, name: h.name });
                setQ(h.name);
                setHits([]);
              }}
            >
              <strong>{h.name}</strong>
              {h.disambiguation && <span className="muted"> — {h.disambiguation}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
