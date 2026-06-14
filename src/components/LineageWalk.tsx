"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArtistRef } from "@/lib/types";

interface WalkArtist {
  mbid: string; name: string;
  tempo_bpm?: number; key?: string; brightness?: string; energy_shape?: string;
  track: { title: string; previewUrl: string; artworkUrl?: string } | null;
}
interface Walk {
  direction: "forward" | "back";
  artists: WalkArtist[];
  links: { from: string; to: string; similarity: number }[];
  narration: string;
}

export default function LineageWalk() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ArtistRef[]>([]);
  const [start, setStart] = useState<{ mbid: string; name: string } | null>(null);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [walk, setWalk] = useState<Walk | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2 || (start && q === start.name)) { setHits([]); return; }
    timer.current = setTimeout(async () => {
      try { const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`); setHits((await r.json()).artists || []); } catch { /* */ }
    }, 350);
  }, [q, start]);

  async function build() {
    if (!start || busy) return;
    setBusy(true); setError(""); setWalk(null); setCur(-1); setPlaying(false);
    setStage(
      direction === "forward"
        ? `Walking forward through who ${start.name} influenced…`
        : `Walking back through who influenced ${start.name}…`
    );
    const t1 = setTimeout(() => setStage("Fingerprinting each artist's sound (this can take a moment the first time)…"), 6000);
    const t2 = setTimeout(() => setStage("Writing the documentary narration…"), 30000);
    try {
      const res = await fetch("/api/lineage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mbid: start.mbid, name: start.name, direction, hops: 3 }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || `failed (${res.status})`);
      else setWalk(data);
    } catch (e) { setError(e instanceof Error ? e.message : "request failed"); }
    finally { clearTimeout(t1); clearTimeout(t2); setBusy(false); setStage(""); }
  }

  function playFrom(i: number) {
    if (!walk) return;
    const a = walk.artists[i];
    if (!a?.track) return;
    setCur(i); setPlaying(true);
    const el = audio.current;
    if (el) { el.src = a.track.previewUrl; el.play().catch(() => {}); }
  }
  function onEnded() {
    if (!walk) return;
    const next = cur + 1;
    if (next < walk.artists.length && walk.artists[next].track) playFrom(next);
    else { setPlaying(false); setCur(-1); }
  }
  function toggle() {
    if (playing) { audio.current?.pause(); setPlaying(false); }
    else playFrom(cur >= 0 ? cur : 0);
  }

  return (
    <div className="lineage">
      <div className="lineage-head">
        <h2>Lineage Walk</h2>
        <p className="muted">
          Pick a starting artist and a direction. We walk the influence graph hop
          by hop, fingerprint each artist&apos;s sound, and play their tracks back
          to back as a guided <strong>audio documentary</strong> — narrated by how
          the sound actually mutates along the way.
        </p>
      </div>

      <div className="lineage-pick">
        <div className="lineage-search">
          <input className="search-input" placeholder="Start with an artist — Black Sabbath, Pink Floyd…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          {hits.length > 0 && (
            <div className="results">
              {hits.map((a) => (
                <div key={a.mbid} className="result-row" onClick={() => { setStart({ mbid: a.mbid, name: a.name }); setQ(a.name); setHits([]); setWalk(null); }}>
                  <strong>{a.name}</strong>{a.disambiguation && <span className="muted"> — {a.disambiguation}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="lineage-dir">
          <button className={`studio-tab ${direction === "forward" ? "on" : ""}`} onClick={() => setDirection("forward")}>Forward — who they influenced →</button>
          <button className={`studio-tab ${direction === "back" ? "on" : ""}`} onClick={() => setDirection("back")}>← Back — who influenced them</button>
        </div>
        <button className="btn-solid lineage-go" disabled={!start || busy} onClick={build}>
          {busy ? "Walking…" : start ? `🧭 Walk the lineage from ${start.name}` : "Pick a starting artist"}
        </button>
        {busy && stage && <div className="lineage-stage muted"><span className="spinner" /> &nbsp;{stage}</div>}
        {error && <div className="lineage-error">⚠️ {error}</div>}
      </div>

      {walk && (
        <div className="lineage-result">
          <div className="lineage-controls">
            <button className="btn-mini" onClick={toggle}>{playing ? "⏸ Pause" : "▶ Play the walk"}</button>
            <span className="muted">{walk.artists.length} stops · plays each clip back to back</span>
          </div>

          <div className="lineage-chain">
            {walk.artists.map((a, i) => (
              <div key={a.mbid} className="lineage-node-wrap">
                <button className={`lineage-node ${cur === i ? "on" : ""}`} onClick={() => playFrom(i)} disabled={!a.track}>
                  {a.track?.artworkUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.track.artworkUrl} alt={a.name} />
                  )}
                  <div className="lineage-node-name">{a.name}</div>
                  <div className="lineage-node-feat muted">{[a.tempo_bpm && `${a.tempo_bpm} BPM`, a.key].filter(Boolean).join(" · ")}</div>
                  <Link className="lineage-node-dna" href={`/artist/${a.mbid}`} onClick={(e) => e.stopPropagation()}>DNA →</Link>
                </button>
                {i < walk.links.length && (
                  <div className="lineage-arrow">→<span className="lineage-sim">{Math.round(walk.links[i].similarity * 100)}%</span></div>
                )}
              </div>
            ))}
          </div>

          {walk.narration && (
            <div className="lineage-narration">
              <div className="stat-label">🎙️ The walk</div>
              <p>{walk.narration}</p>
            </div>
          )}
        </div>
      )}
      <audio ref={audio} hidden onEnded={onEnded} />
    </div>
  );
}
