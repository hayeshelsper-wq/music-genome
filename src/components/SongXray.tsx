"use client";

import { useEffect, useState } from "react";
import StemLab from "./StemLab";

interface Features {
  tempo_bpm: number;
  tempo_feel: string;
  key: string;
  key_confidence: number;
  harmonic_emphasis: string[];
  chords?: string[];
  chords_roman?: string[];
  progression?: string | null;
  brightness: string;
  texture: string;
  density: string;
  dynamics: string;
  energy_arc: number[];
  energy_shape: string;
}
interface TagItem {
  label: string;
  prob: number;
}
interface TagSet {
  instruments?: TagItem[];
  genres?: TagItem[];
  moods?: TagItem[];
  voice?: { vocal: boolean; prob: number };
}
interface Analysis {
  features: Features | null;
  chromagram: string | null;
  genius: {
    fullTitle: string;
    url: string;
    releaseDate?: string;
    producers: string[];
    writers: string[];
  } | null;
  flamingo: string;
  flamingoError?: string;
  flamingoStatus?: "complete" | "pending";
  tags?: TagSet | null;
  fullLyrics: string;
  notableLyrics: string[];
  lyricsSource: string;
  breakdown: string;
  model: string;
  error?: string;
}

// Turn a raw flamingo error into a one-line, user-readable reason.
function flamingoReason(err?: string): string | null {
  if (!err || err === "disabled") return null; // disabled = intentional, no note
  if (err.includes("unreachable")) return "the audio service isn't running";
  if (err.includes("space") || err.includes("no response") || err.includes("completion"))
    return "NVIDIA's public GPU Space is erroring right now (free-tier quota/cold start)";
  return err;
}

export default function SongXray({
  previewUrl,
  title,
  artist,
}: {
  previewUrl: string;
  title: string;
  artist: string;
}) {
  const [data, setData] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showStems, setShowStems] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    setShowStems(false);
    (async () => {
      try {
        const qs = `previewUrl=${encodeURIComponent(previewUrl)}&title=${encodeURIComponent(
          title
        )}&artist=${encodeURIComponent(artist)}`;
        const res = await fetch(`/api/track/analyze?${qs}`);
        const json = (await res.json()) as Analysis;
        if (!res.ok) throw new Error(json.error || "analysis failed");
        if (!alive) return;
        setData(json);

        // Cold GPU → Flamingo pending: poll the warm-gated backfill until it lands
        // and merge it + the regenerated review in. Each poll is a fast (~6s)
        // warmth probe that also nudges the GPU awake, so we cycle quickly and grab
        // the read the moment it's warm. A cold start is image-pull dominated
        // (~5-7min), so keep polling well past that. The page is fully usable
        // meanwhile, and this resumes nothing else has to.
        if (json.flamingoStatus === "pending" && !json.flamingo) {
          for (let i = 0; i < 80 && alive; i++) {
            let bf: {
              flamingo?: string;
              breakdown?: string;
              notableLyrics?: string[];
              model?: string;
            } = {};
            try {
              const r = await fetch(`/api/track/flamingo?${qs}`);
              bf = await r.json();
            } catch {
              /* transient — retry */
            }
            if (!alive) return;
            if (bf.flamingo) {
              setData((prev) =>
                prev
                  ? {
                      ...prev,
                      flamingo: bf.flamingo!,
                      breakdown: bf.breakdown || prev.breakdown,
                      notableLyrics: bf.notableLyrics ?? prev.notableLyrics,
                      model: bf.model || prev.model,
                      flamingoStatus: "complete",
                    }
                  : prev
              );
              return;
            }
            await new Promise((r) => setTimeout(r, 8000));
          }
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "failed");
      }
    })();
    return () => {
      alive = false;
    };
  }, [previewUrl, title, artist]);

  if (error)
    return (
      <div className="xray">
        <p className="muted">
          Couldn’t analyze this track: {error}
          <br />
          <span style={{ fontSize: 12 }}>
            (the Python audio service must be running — see audio-service/README)
          </span>
        </p>
      </div>
    );

  if (!data)
    return (
      <div className="xray">
        <div className="xray-loading">
          <span className="spinner" />
          <div>
            <strong>X-raying “{title}”…</strong>
            <div className="muted" style={{ fontSize: 13 }}>
              librosa measurement → Music Flamingo (NVIDIA audio-LLM on GPU) →
              Genius → a Grammy-producer critique. First run ~30–60s, then instant.
            </div>
          </div>
        </div>
      </div>
    );

  const f = data.features;
  return (
    <div className="xray">
      <div className="xray-head">
        <h3>🔬 Song X-Ray — {title}</h3>
        {data.genius?.url && (
          <a href={data.genius.url} target="_blank" rel="noreferrer" className="xray-genius">
            Genius ↗
          </a>
        )}
      </div>

      {/* provenance legend — every section below is tagged by where it came from,
          making the "measured fact vs. AI interpretation" line explicit. */}
      <div className="xray-legend">
        <span className="muted">Sources</span>
        <SourceTag kind="measured" />
        <SourceTag kind="heard" />
        <SourceTag kind="written" />
        <SourceTag kind="data" />
      </div>

      {/* measured features (librosa DSP — ground truth) */}
      {f && (
        <div className="xray-section-head">
          <span className="stat-label">Measurements</span>
          <SourceTag kind="measured" />
        </div>
      )}
      {f && (
        <div className="xray-stats">
          <Stat label="Key" value={f.key} sub={`conf ${f.key_confidence}`} />
          <Stat label="Tempo" value={`${f.tempo_bpm}`} unit="BPM" sub={f.tempo_feel} />
          <Stat label="Texture" value={f.texture} />
          <Stat label="Brightness" value={f.brightness} />
          <Stat label="Density" value={f.density} />
          <Stat label="Dynamics" value={f.dynamics} />
        </div>
      )}

      {/* discriminative tagger — reliable instruments / genre / mood / vocal */}
      {data.tags &&
        (data.tags.instruments?.length || data.tags.voice || data.tags.genres?.length) && (
          <div className="xray-tags">
            <div className="xray-section-head">
              <span className="stat-label">📊 Detected</span>
              <SourceTag kind="measured" />
            </div>
            {data.tags.voice && (
              <div className="tag-line">
                <span className="tag-key">Vocals</span>
                <span className={`tag-chip ${data.tags.voice.vocal ? "yes" : "no"}`}>
                  {data.tags.voice.vocal ? "🎤 vocal" : "🎻 instrumental"}
                </span>
              </div>
            )}
            {!!data.tags.instruments?.length && (
              <div className="tag-line">
                <span className="tag-key">Instruments</span>
                {data.tags.instruments.map((t, i) => (
                  <span key={i} className="tag-chip">
                    {t.label}
                  </span>
                ))}
              </div>
            )}
            {!!data.tags.genres?.length && (
              <div className="tag-line">
                <span className="tag-key">Genre</span>
                {data.tags.genres.map((t, i) => (
                  <span key={i} className="tag-chip soft">
                    {t.label}
                  </span>
                ))}
              </div>
            )}
            {!!data.tags.moods?.length && (
              <div className="tag-line">
                <span className="tag-key">Mood</span>
                {data.tags.moods.map((t, i) => (
                  <span key={i} className="tag-chip soft">
                    {t.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

      {/* energy arc + chromagram side by side */}
      <div className="xray-viz">
        {f && (
          <div className="xray-arc-wrap">
            <div className="stat-label">
              Energy across the clip · {f.energy_shape}
            </div>
            <div className="xray-arc">
              {f.energy_arc.map((v, i) => (
                <div
                  key={i}
                  className="xray-bar"
                  style={{ height: `${Math.max(6, (v / Math.max(...f.energy_arc)) * 100)}%` }}
                />
              ))}
            </div>
            <div className="stat-label" style={{ marginTop: 6 }}>
              Harmonic emphasis: {f.harmonic_emphasis.join(" · ")}
            </div>
          </div>
        )}
        {data.chromagram && (
          <div className="xray-chroma">
            <div className="stat-label">Chromagram (pitch content over time)</div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={data.chromagram} alt="chromagram" />
          </div>
        )}
      </div>

      {/* estimated chord progression (librosa chroma → triad templates) */}
      {f?.chords && f.chords.length > 0 && (
        <div className="xray-chords">
          <div className="xray-section-head">
            <span className="stat-label">
              Chord progression <span className="muted">(estimated)</span>
            </span>
            <SourceTag kind="measured" />
          </div>
          <div className="chord-row">
            {f.chords.map((c, i) => (
              <span key={i} className="chord-chip">
                <span className="chord-name">{c}</span>
                {f.chords_roman?.[i] && (
                  <span className="chord-roman">{f.chords_roman[i]}</span>
                )}
              </span>
            ))}
          </div>
          {f.progression && <div className="chord-prog">↳ {f.progression}</div>}
        </div>
      )}

      {/* Music Flamingo — AI listener's musician read. Cold GPU → pending banner
          while the backfill warms it up and auto-updates this section in place. */}
      {data.flamingo ? (
        <details className="xray-flamingo">
          <summary>
            🦩 Music Flamingo heard this <SourceTag kind="heard" />{" "}
            <span className="muted">(informed but fallible)</span>
          </summary>
          <div className="xray-flamingo-body">{data.flamingo}</div>
        </details>
      ) : data.flamingoStatus === "pending" ? (
        <div className="flamingo-pending">
          <span className="spinner" />
          <span>
            🦩 The GPU was cold, so Music Flamingo is spinning up to listen to this
            clip and upgrade the review with its read. This can take a couple of
            minutes on a cold start — everything above is ready now, and this
            updates automatically when it lands (no need to refresh).
          </span>
        </div>
      ) : (
        flamingoReason(data.flamingoError) && (
          <div className="xray-flamingo-note muted">
            🦩 Music Flamingo unavailable — {flamingoReason(data.flamingoError)}.
            The measurements above and the producer&apos;s critique below still run
            on librosa + Genius.
          </div>
        )
      )}

      {/* The review — narrative, descriptive (LLM, grounded in measurements + Flamingo) */}
      {data.breakdown && (
        <div className="xray-breakdown">
          <div className="xray-section-head">
            <span className="stat-label">📝 The Review</span>
            <SourceTag kind="written" />
          </div>
          <p>{data.breakdown}</p>
          <div className="xray-model muted">
            review by {data.model}
            {data.flamingo ? " · informed by Music Flamingo + librosa" : " · from librosa measurements"}
          </div>
        </div>
      )}

      {/* notable lyrics + credits */}
      <div className="xray-foot">
        {data.notableLyrics.length > 0 && (
          <div className="xray-lyrics">
            <div className="stat-label">Notable lyrics</div>
            {data.notableLyrics.map((l, i) => (
              <div key={i} className="xray-lyric">“{l}”</div>
            ))}
          </div>
        )}
        {data.genius && (data.genius.writers.length > 0 || data.genius.producers.length > 0) && (
          <div className="xray-credits">
            {data.genius.releaseDate && (
              <div><span className="stat-label">Released</span> {data.genius.releaseDate}</div>
            )}
            {data.genius.writers.length > 0 && (
              <div><span className="stat-label">Writers</span> {data.genius.writers.join(", ")}</div>
            )}
            {data.genius.producers.length > 0 && (
              <div><span className="stat-label">Producers</span> {data.genius.producers.join(", ")}</div>
            )}
          </div>
        )}
      </div>

      {/* full lyrics (accurate, whole-song, from Genius) */}
      {data.fullLyrics && (
        <div className="xray-lyricsheet">
          <div className="xray-lyricsheet-head">
            <span className="stat-label">Lyrics</span>
            <span className="muted" style={{ fontSize: 11 }}>full song · Genius</span>
          </div>
          <div className="xray-lyricsheet-body">{renderLyrics(data.fullLyrics)}</div>
        </div>
      )}

      {/* Stem Lab (Demucs) — opt-in, it's GPU-heavy */}
      <div style={{ marginTop: 18 }}>
        {!showStems ? (
          <button className="btn" onClick={() => setShowStems(true)}>
            🎛️ Separate stems (Demucs) — solo vocals/drums/bass, melody & groove
          </button>
        ) : (
          <StemLab previewUrl={previewUrl} title={title} artist={artist} />
        )}
      </div>
    </div>
  );
}

// Render Genius lyrics: [Section] tags become labels, blank lines become gaps.
function renderLyrics(text: string) {
  return text.split("\n").map((line, i) => {
    const t = line.trim();
    if (!t) return <div key={i} className="ly-gap" />;
    if (/^\[.*\]$/.test(t)) return <div key={i} className="ly-section">{t.replace(/^\[|\]$/g, "")}</div>;
    return <div key={i} className="ly-line">{t}</div>;
  });
}

// Provenance chip — makes the data lineage of each section explicit (the
// "measured fact vs. AI interpretation" distinction that keeps the analysis
// trustworthy as training/caption data).
function SourceTag({ kind }: { kind: "measured" | "heard" | "written" | "data" }) {
  const map = {
    measured: { icon: "📐", label: "Measured · librosa", title: "Deterministic DSP — ground truth" },
    heard: { icon: "🦩", label: "Heard · Flamingo", title: "Audio Flamingo 3 — a model's read of the waveform" },
    written: { icon: "✦", label: "Written · Claude", title: "LLM prose, grounded in the measurements + Flamingo" },
    data: { icon: "📖", label: "Data · Genius/lrclib", title: "Real credits & lyrics" },
  } as const;
  const s = map[kind];
  return (
    <span className={`src-tag src-${kind}`} title={s.title}>
      {s.icon} {s.label}
    </span>
  );
}

function Stat({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
}) {
  return (
    <div className="xray-stat">
      <div className="stat-label">{label}</div>
      <div className="xray-stat-value">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {sub && <div className="xray-stat-sub">{sub}</div>}
    </div>
  );
}
