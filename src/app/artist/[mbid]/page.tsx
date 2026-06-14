"use client";

import { CSSProperties, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Graph from "@/components/Graph";
import SonicDna from "@/components/SonicDna";
import { useVibrantColor } from "@/components/useVibrantColor";
import { ArtistDnaReport } from "@/lib/types";

interface TopTrack { artworkUrl?: string }

function ArtistHero({
  name,
  image,
  meta,
  tags,
}: {
  name: string;
  image?: string;
  meta?: string;
  tags?: string[];
}) {
  return (
    <div className="pl-hero">
      <Link href="/" className="pl-back">
        ← search
      </Link>
      <div className="pl-hero-inner">
        <div className="pl-cover round">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" />
          ) : (
            <span className="pl-cover-blank">{(name || "♪").slice(0, 1)}</span>
          )}
        </div>
        <div className="pl-hero-text">
          <span className="pl-eyebrow">Artist</span>
          <h1 className="pl-title">{name}</h1>
          {meta && <div className="pl-meta">{meta}</div>}
          {tags && tags.length > 0 && (
            <div className="pl-herotags">
              {tags.slice(0, 8).map((t) => (
                <span className="tag" key={t}>
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ArtistPage() {
  const { mbid } = useParams<{ mbid: string }>();
  const [report, setReport] = useState<ArtistDnaReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errCode, setErrCode] = useState<string | null>(null);
  const [warming, setWarming] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [narrLoading, setNarrLoading] = useState(false);
  const [fallbackName, setFallbackName] = useState<string | null>(null);
  const [heroImg, setHeroImg] = useState<string | undefined>(undefined);
  const rgb = useVibrantColor(heroImg);

  useEffect(() => {
    setReport(null);
    setError(null);
    setErrCode(null);
    setWarming(false);
    setNarrative(null);
    let alive = true;
    (async () => {
      // A paused Aura Free instance resumes in ~30–60s and fails fast meanwhile,
      // so auto-retry a "warming up" graph a few times before giving up.
      const waits = [0, 8000, 16000, 26000];
      for (let i = 0; i < waits.length; i++) {
        if (!alive) return;
        if (waits[i]) {
          setWarming(true);
          await new Promise((r) => setTimeout(r, waits[i]));
          if (!alive) return;
        }
        try {
          const res = await fetch(`/api/artist/${mbid}`);
          const data = await res.json();
          if (res.ok) {
            if (alive) {
              setReport(data);
              setWarming(false);
            }
            return;
          }
          if (data.code === "unavailable" && i < waits.length - 1) continue;
          if (alive) {
            setError(data.error || "failed");
            setErrCode(data.code || "error");
            setWarming(false);
          }
          return;
        } catch (e: unknown) {
          if (i < waits.length - 1) continue;
          if (alive) {
            setError(e instanceof Error ? e.message : "failed");
            setErrCode("error");
            setWarming(false);
          }
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [mbid, retryKey]);

  // Representative artwork drives the hero gradient (and provides a name fallback
  // in graph-less degraded mode). iTunes is keyless, so this works without Neo4j.
  useEffect(() => {
    let alive = true;
    setHeroImg(undefined);
    (async () => {
      try {
        const res = await fetch(`/api/artist/${mbid}/audio`);
        const d = await res.json();
        if (!alive) return;
        if (d?.artist?.name) setFallbackName(d.artist.name);
        const art = (d?.topTracks as TopTrack[] | undefined)?.find(
          (t) => t.artworkUrl
        )?.artworkUrl;
        if (art) setHeroImg(art);
      } catch {
        /* no artwork — hero falls back to the default gradient + initial */
      }
    })();
    return () => {
      alive = false;
    };
  }, [mbid]);

  async function genNarrative() {
    setNarrLoading(true);
    try {
      const res = await fetch(`/api/artist/${mbid}/narrative`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed");
      setNarrative(data.narrative);
    } catch (e: unknown) {
      setNarrative(
        `_Couldn't generate narrative: ${e instanceof Error ? e.message : "failed"}_`
      );
    } finally {
      setNarrLoading(false);
    }
  }

  const heroStyle = {
    "--hero-rgb": `${rgb[0]} ${rgb[1]} ${rgb[2]}`,
  } as CSSProperties;

  // Graph unavailable (e.g. Neo4j not configured) — don't dead-end. The Sonic DNA
  // previews are keyless and graph-free, so render those under the same hero.
  if (error)
    return (
      <div className="pl-page" style={heroStyle}>
        <ArtistHero name={fallbackName || "Artist"} image={heroImg} />
        <div className="pl-body">
          <div className="notice" style={{ marginTop: 18 }}>
            {errCode === "unconfigured" ? (
              <>
                Knowledge graph unavailable — the influence tree, collaborator
                network, genre timeline and DNA narrative need the data store
                (Firestore). Locally, run{" "}
                <code>gcloud auth application-default login</code> or start the
                Firestore emulator. The audio previews below need no setup.
              </>
            ) : errCode === "unavailable" ? (
              <>
                The data store is temporarily unavailable.{" "}
                <button className="btn-inline" onClick={() => setRetryKey((k) => k + 1)}>
                  Retry
                </button>{" "}
                — or play the previews below in the meantime.
              </>
            ) : (
              <>
                Couldn&apos;t load the knowledge graph ({error}).{" "}
                <button className="btn-inline" onClick={() => setRetryKey((k) => k + 1)}>
                  Retry
                </button>
              </>
            )}
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
      </div>
    );

  if (!report)
    return (
      <div className="container center" style={{ paddingTop: 120 }}>
        <span className="spinner" />
        <p className="muted">
          {warming
            ? "Waking up the graph database… (Aura Free instances sleep when idle — this takes ~30–60s the first time)"
            : "Building the genome… first load ingests from MusicBrainz, Wikidata & Last.fm and can take up to a minute."}
        </p>
      </div>
    );

  const a = report.artist;
  const hasFamily = report.family.links.length > 0;
  const hasCollab = report.collaborators.links.length > 0;
  const meta = [a.type, a.country, a.beginYear && `since ${a.beginYear}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="pl-page" style={heroStyle}>
      <ArtistHero name={a.name} image={heroImg} meta={meta} tags={report.tags} />

      <div className="pl-body">
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
          {narrative && <div className="panel narrative">{renderMarkdown(narrative)}</div>}
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
              <div style={{ marginTop: 12 }}>
                <Link className="lib-link" href={`/trail?mbid=${a.mbid}&name=${encodeURIComponent(a.name)}`}>
                  🎧 Hear these influences as a trail →
                </Link>
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
