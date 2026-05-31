"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Graph from "@/components/Graph";
import SonicDna from "@/components/SonicDna";
import { ArtistDnaReport } from "@/lib/types";

export default function ArtistPage() {
  const { mbid } = useParams<{ mbid: string }>();
  const [report, setReport] = useState<ArtistDnaReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [narrLoading, setNarrLoading] = useState(false);
  const [fallbackName, setFallbackName] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    setError(null);
    setNarrative(null);
    (async () => {
      try {
        const res = await fetch(`/api/artist/${mbid}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "failed");
        setReport(data);
      } catch (e: any) {
        setError(e.message);
      }
    })();
  }, [mbid]);

  async function genNarrative() {
    setNarrLoading(true);
    try {
      const res = await fetch(`/api/artist/${mbid}/narrative`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed");
      setNarrative(data.narrative);
    } catch (e: any) {
      setNarrative(`_Couldn't generate narrative: ${e.message}_`);
    } finally {
      setNarrLoading(false);
    }
  }

  // Graph unavailable (e.g. Neo4j not configured) — don't dead-end. The Sonic
  // DNA previews are keyless and graph-free, so render those anyway.
  if (error)
    return (
      <div className="container">
        <Link href="/" className="muted">
          ← search
        </Link>
        <div className="report-header" style={{ marginTop: 16 }}>
          <h1>{fallbackName || "Artist"}</h1>
        </div>
        <div className="notice">
          Knowledge graph unavailable — the influence tree, collaborator network,
          genre timeline and DNA narrative need Neo4j (set <code>NEO4J_*</code> in{" "}
          <code>.env.local</code>). The audio previews below need no setup.
        </div>
        <div className="section">
          <h2>Sonic DNA</h2>
          <p className="hint">
            Playable 30-second previews and album art (iTunes). No Spotify, no
            keys, no database required.
          </p>
          <SonicDna mbid={mbid} onName={setFallbackName} />
        </div>
      </div>
    );

  if (!report)
    return (
      <div className="container center" style={{ paddingTop: 120 }}>
        <span className="spinner" />
        <p className="muted">
          Building the genome… (first load ingests from MusicBrainz, Wikidata &
          Last.fm — can take a few seconds)
        </p>
      </div>
    );

  const a = report.artist;
  const hasFamily = report.family.links.length > 0;
  const hasCollab = report.collaborators.links.length > 0;

  return (
    <div className="container">
      <Link href="/" className="muted">
        ← search
      </Link>

      <div className="report-header" style={{ marginTop: 16 }}>
        <h1>{a.name}</h1>
        <span className="sub">
          {[a.type, a.country, a.beginYear && `since ${a.beginYear}`]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>

      {report.tags.length > 0 && (
        <div className="tags" style={{ marginTop: 14 }}>
          {report.tags.map((t) => (
            <span className="tag" key={t}>
              {t}
            </span>
          ))}
        </div>
      )}

      {/* ---- Sonic DNA: previews + audio features ---- */}
      <div className="section">
        <h2>Sonic DNA</h2>
        <p className="hint">
          Playable 30-second previews and album art (iTunes). Audio-feature
          analysis — tempo, key, danceability, mood — fades in when AcousticBrainz
          has data for the artist. No Spotify required.
        </p>
        <SonicDna mbid={a.mbid} name={a.name} />
      </div>

      {/* ---- DNA narrative ---- */}
      <div className="section">
        <h2>DNA Profile</h2>
        {!narrative && (
          <button className="btn" onClick={genNarrative} disabled={narrLoading}>
            {narrLoading ? "Synthesizing…" : "Generate DNA profile ✨"}
          </button>
        )}
        {narrLoading && !narrative && (
          <span className="muted"> &nbsp;<span className="spinner" /> the LLM is reading the graph…</span>
        )}
        {narrative && (
          <div className="panel narrative">
            {renderMarkdown(narrative)}
          </div>
        )}
      </div>

      {/* ---- Family tree ---- */}
      <div className="section">
        <h2>Musical Family Tree</h2>
        <p className="hint">
          Directional influence from Wikidata. Click any MusicBrainz node to jump
          into its genome.
        </p>
        {hasFamily ? (
          <>
            <Graph nodes={report.family.nodes} links={report.family.links} />
            <div className="legend">
              <span><i className="dot" style={{ background: "#ffd166" }} /> {a.name}</span>
              <span><i className="dot" style={{ background: "#06d6a0" }} /> influenced by →</span>
              <span><i className="dot" style={{ background: "#ef476f" }} /> → went on to influence</span>
            </div>
          </>
        ) : (
          <p className="muted">
            No influence edges in Wikidata for this artist yet. (This is the data
            gap the platform eventually fills with its own graph.)
          </p>
        )}
      </div>

      {/* ---- Collaborator graph ---- */}
      <div className="section">
        <h2>Collaborator Network</h2>
        <p className="hint">Bands, members, producers & collaborators from MusicBrainz.</p>
        {hasCollab ? (
          <Graph nodes={report.collaborators.nodes} links={report.collaborators.links} />
        ) : (
          <p className="muted">No collaborator relations recorded.</p>
        )}
      </div>

      {/* ---- Genre timeline ---- */}
      {report.timeline.length > 0 && (
        <div className="section">
          <h2>Genre Evolution</h2>
          <p className="hint">Studio albums over time, with community genres.</p>
          <div className="panel timeline">
            {report.timeline.map((t, i) => (
              <div className="tl-row" key={`${t.year}-${i}`}>
                <div className="tl-year">{t.year}</div>
                <div>
                  <div className="tl-release">{t.release}</div>
                  <div className="tl-genres">{t.genres.join(" · ")}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- Sonic neighbors ---- */}
      {report.similar.length > 0 && (
        <div className="section">
          <h2>Sounds Adjacent</h2>
          <p className="hint">Last.fm listener-overlap neighbors.</p>
          <div className="similar-grid">
            {report.similar.map((s) => (
              <span className="similar-chip" key={s.name}>
                {s.name}
                <span className="pct">{Math.round(s.match * 100)}%</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Tiny markdown renderer: just ## headers + paragraphs (no deps).
function renderMarkdown(md: string) {
  return md.split("\n").map((line, i) => {
    const t = line.trim();
    if (!t) return null;
    if (t.startsWith("## ")) return <h2 key={i}>{t.slice(3)}</h2>;
    if (t.startsWith("# ")) return <h2 key={i}>{t.slice(2)}</h2>;
    return <p key={i}>{t}</p>;
  });
}
