"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArtistRef, GraphNode } from "@/lib/types";

interface SonicView {
  mbid: string;
  name: string;
  tempo_bpm?: number;
  brightness?: string;
  brightness_hz?: number;
  texture?: string;
  density?: string;
  dynamics?: string;
  energy_shape?: string;
  key?: string;
  trackCount?: number;
  tracks: { title: string; previewUrl: string; artworkUrl?: string }[];
}
interface Delta { label: string; a: string; b: string; note?: string }
interface TrailResult {
  a: SonicView;
  b: SonicView;
  influencer: "a" | "b";
  similarity: number;
  deltas: Delta[];
  narration: string;
}

const isMbid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);

function simColor(s: number): string {
  if (s >= 0.6) return "var(--influence)";
  if (s >= 0.4) return "var(--root)";
  return "var(--descendant)";
}

export default function InfluenceTrail() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ArtistRef[]>([]);
  const [artistA, setArtistA] = useState<{ mbid: string; name: string } | null>(null);
  const [influences, setInfluences] = useState<GraphNode[]>([]);
  const [descendants, setDescendants] = useState<GraphNode[]>([]);
  const [familyState, setFamilyState] = useState<"idle" | "loading" | "ready" | "empty">("idle");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<TrailResult | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioA = useRef<HTMLAudioElement | null>(null);
  const audioB = useRef<HTMLAudioElement | null>(null);

  // Prefill from ?mbid=&name= (deep link from an artist page).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const mbid = p.get("mbid");
    const name = p.get("name");
    if (mbid && name) pickArtist({ mbid, name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    // Don't re-open the dropdown when the query already equals the picked artist
    // (e.g. right after a pick, or a ?mbid=&name= deep-link prefill).
    if (q.trim().length < 2 || (artistA && q === artistA.name)) { setHits([]); return; }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const d = await r.json();
        setHits(d.artists || []);
      } catch { /* ignore */ }
    }, 350);
  }, [q, artistA]);

  async function pickArtist(a: { mbid: string; name: string }) {
    setArtistA(a);
    setQ(a.name);
    setHits([]);
    setResult(null);
    setError("");
    setFamilyState("loading");
    setInfluences([]);
    setDescendants([]);
    try {
      const r = await fetch(`/api/artist/${a.mbid}`);
      const rep = await r.json();
      if (!r.ok) throw new Error(rep.error || "could not load DNA");
      const nodes: GraphNode[] = rep.family?.nodes || [];
      const inf = nodes.filter((n) => n.group === "influence" && isMbid(n.id));
      const desc = nodes.filter((n) => n.group === "descendant" && isMbid(n.id));
      setInfluences(inf);
      setDescendants(desc);
      setFamilyState(inf.length || desc.length ? "ready" : "empty");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load family");
      setFamilyState("idle");
    }
  }

  async function trace(node: GraphNode, kind: "influence" | "descendant") {
    if (!artistA || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    setStage(`Measuring the sonic DNA of ${artistA.name} and ${node.name}…`);
    const t1 = setTimeout(() => setStage("Comparing catalogs in CLAP space + measuring deltas…"), 8000);
    const t2 = setTimeout(() => setStage("Writing the inheritance story…"), 20000);
    try {
      const res = await fetch("/api/trail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          a: artistA,
          b: { mbid: node.id, name: node.name },
          // influence chip = that artist influenced A; descendant = A influenced them.
          influencer: kind === "influence" ? "b" : "a",
        }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || `failed (${res.status})`);
      else setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      clearTimeout(t1); clearTimeout(t2);
      setBusy(false); setStage("");
    }
  }

  function playBoth() {
    const a = audioA.current, b = audioB.current;
    if (!a || !b) return;
    b.pause(); b.currentTime = 0;
    a.currentTime = 0;
    const onEnd = () => { a.removeEventListener("ended", onEnd); b.play().catch(() => {}); };
    a.addEventListener("ended", onEnd);
    a.play().catch(() => {});
  }

  const earlier = result ? (result.influencer === "a" ? result.a : result.b) : null;
  const later = result ? (result.influencer === "a" ? result.b : result.a) : null;

  return (
    <div className="trail">
      <div className="trail-head">
        <h2>Audible Influence Trails</h2>
        <p className="muted">
          Pick an artist, then pick someone in their family tree. We measure both
          catalogs&apos; sonic DNA, score how much sound was inherited, and play
          them back to back — so you can <strong>hear</strong> the lineage, not
          just look at it.
        </p>
      </div>

      <div className="trail-pick">
        <div className="trail-search">
          <input
            className="search-input"
            placeholder="Start with an artist — Black Sabbath, Radiohead…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {hits.length > 0 && (
            <div className="results">
              {hits.map((a) => (
                <div key={a.mbid} className="result-row" onClick={() => pickArtist({ mbid: a.mbid, name: a.name })}>
                  <strong>{a.name}</strong>
                  {a.disambiguation && <span className="muted"> — {a.disambiguation}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {artistA && familyState === "loading" && (
          <div className="trail-stage muted"><span className="spinner" /> &nbsp;Loading {artistA.name}&apos;s family tree…</div>
        )}
        {artistA && familyState === "empty" && (
          <p className="muted" style={{ marginTop: 12 }}>No influence edges in Wikidata for {artistA.name} yet — try another artist.</p>
        )}
        {artistA && familyState === "ready" && (
          <div className="trail-family">
            {influences.length > 0 && (
              <div className="trail-group">
                <div className="stat-label">{artistA.name} was influenced by</div>
                <div className="trail-chips">
                  {influences.map((n) => (
                    <button key={n.id} className="trail-chip inf" disabled={busy} onClick={() => trace(n, "influence")}>
                      {n.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {descendants.length > 0 && (
              <div className="trail-group">
                <div className="stat-label">{artistA.name} went on to influence</div>
                <div className="trail-chips">
                  {descendants.map((n) => (
                    <button key={n.id} className="trail-chip desc" disabled={busy} onClick={() => trace(n, "descendant")}>
                      {n.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {busy && stage && <div className="trail-stage muted"><span className="spinner" /> &nbsp;{stage}</div>}
        {error && <div className="trail-error">⚠️ {error}</div>}
      </div>

      {result && earlier && later && (
        <div className="trail-result">
          <div className="trail-flow">
            <ArtistCard view={earlier} role="influence" audioRef={earlier === result.a ? audioA : audioB} />
            <div className="trail-mid">
              <div className="trail-sim-ring" style={{ ["--c" as string]: simColor(result.similarity) }}>
                <span className="trail-sim-num">{Math.round(result.similarity * 100)}%</span>
                <span className="trail-sim-lbl">sonic match</span>
              </div>
              <div className="trail-arrow">influenced →</div>
              <button className="btn-mini" onClick={playBoth}>▶ Hear both</button>
            </div>
            <ArtistCard view={later} role="descendant" audioRef={later === result.a ? audioA : audioB} />
          </div>

          {result.narration && (
            <div className="trail-narration">
              <div className="stat-label">📜 The inheritance</div>
              <p>{result.narration}</p>
            </div>
          )}

          <table className="trail-table">
            <thead>
              <tr><th>Dimension</th><th>{earlier.name}</th><th>{later.name}</th><th></th></tr>
            </thead>
            <tbody>
              {result.deltas.map((d) => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  <td>{d.a}</td>
                  <td>{d.b}</td>
                  <td className="trail-note">{d.note || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ArtistCard({
  view,
  role,
  audioRef,
}: {
  view: SonicView;
  role: "influence" | "descendant";
  audioRef: React.RefObject<HTMLAudioElement | null>;
}) {
  const t = view.tracks[0];
  return (
    <div className={`trail-card ${role}`}>
      <Link className="trail-card-name" href={`/artist/${view.mbid}`}>{view.name}</Link>
      {t?.artworkUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="trail-art" src={t.artworkUrl} alt={t.title} />
      )}
      {t && (
        <>
          <div className="trail-track muted">{t.title}</div>
          <audio ref={audioRef} controls src={t.previewUrl} preload="none" />
        </>
      )}
      <div className="trail-card-feat muted">
        {[view.tempo_bpm && `${view.tempo_bpm} BPM`, view.key, view.brightness].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
}
