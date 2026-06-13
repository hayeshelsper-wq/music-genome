"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import AnalysisResult, { AnalysisData } from "@/components/AnalysisResult";
import { pollFlamingoBackfill } from "@/lib/flamingoBackfill";

interface ListItem {
  id: string;
  title: string;
  filename?: string;
  createdAt: number;
  key?: string;
  tempo?: number;
  durationSec?: number;
  analysisStatus?: string; // "analyzing" | "complete"
}
interface Detail extends AnalysisData {
  id: string;
  title: string;
  analysisStatus?: string;
}
interface SonicHit {
  id: string;
  title: string;
  key?: string;
  tempo?: number;
  distance?: number;
}

function fmtDate(ms?: number) {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export default function LibraryPage() {
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // "search by sound" (CLAP text→audio)
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SonicHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  // ids whose analysis we've already kicked off this session (avoid re-firing)
  const resuming = useRef<Set<string>>(new Set());

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    const query = q.trim();
    if (!query) {
      setHits(null);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/api/sonic-search?q=${encodeURIComponent(query)}`);
      const j = await res.json();
      setHits(j.hits || []);
    } catch {
      setHits([]);
    } finally {
      setSearching(false);
    }
  }

  async function refreshList() {
    try {
      const res = await fetch("/api/uploads");
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "failed");
      setItems(j.items || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setItems([]);
    }
  }

  useEffect(() => {
    refreshList();
  }, []);

  // keep a ref of the open id so the resume effect can refresh the open detail
  const openIdRef = useRef<string | null>(null);
  useEffect(() => {
    openIdRef.current = openId;
  }, [openId]);

  async function reopenDetail(id: string) {
    const res = await fetch(`/api/uploads/${id}`);
    const j = await res.json();
    if (res.ok) setDetail({ ...j, id, title: j.title });
  }

  // Resume any record still "analyzing" — e.g. the user uploaded then navigated
  // here mid-analysis. The analyze endpoint is idempotent + reads the audio from
  // storage, so this drives it to completion and refreshes the list when done.
  useEffect(() => {
    if (!items) return;
    const pending = items.filter((it) => it.analysisStatus === "analyzing");
    pending.forEach((it) => {
      if (resuming.current.has(it.id)) return;
      resuming.current.add(it.id);
      (async () => {
        try {
          await fetch(`/api/uploads/${it.id}/analyze`, { method: "POST" });
        } catch {
          /* transient — leave it; reopening the page retries */
        } finally {
          await refreshList();
          // if it's the open item, refresh its detail too
          if (openIdRef.current === it.id) reopenDetail(it.id);
        }
      })();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  async function open(id: string) {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/uploads/${id}`);
      const j = await res.json();
      if (res.ok) setDetail(j);
      // Still analyzing → resume it; show the result when it completes.
      if (res.ok && j.analysisStatus && j.analysisStatus !== "complete") {
        if (!resuming.current.has(id)) {
          resuming.current.add(id);
          fetch(`/api/uploads/${id}/analyze`, { method: "POST" })
            .catch(() => {})
            .finally(() => refreshList());
        }
        // poll the record until the analysis lands, then render it
        pollAnalysis(id);
        return;
      }
      // resume the Flamingo backfill if this item's GPU read is still pending
      if (res.ok && j.flamingoStatus === "pending" && !j.flamingo) {
        pollFlamingoBackfill(id, (bf) =>
          setDetail((prev) =>
            prev && prev.id === id
              ? {
                  ...prev,
                  flamingo: bf.flamingo,
                  review: bf.breakdown || prev.review,
                  flamingoStatus: "complete",
                }
              : prev
          )
        );
      }
    } finally {
      setLoadingDetail(false);
    }
  }

  // Poll a record's analysis status until it completes, then load the detail and
  // hand off to the Flamingo backfill if that part is still pending.
  async function pollAnalysis(id: string) {
    for (let i = 0; i < 60; i++) {
      if (openIdRef.current !== id) return;
      await new Promise((r) => setTimeout(r, 4000));
      if (openIdRef.current !== id) return;
      let j: Detail | null = null;
      try {
        const res = await fetch(`/api/uploads/${id}`);
        if (res.ok) j = await res.json();
      } catch {
        continue;
      }
      if (!j) continue;
      if (j.analysisStatus === "complete") {
        setDetail({ ...j, id, title: j.title });
        refreshList();
        if (j.flamingoStatus === "pending" && !j.flamingo) {
          pollFlamingoBackfill(id, (bf) =>
            setDetail((prev) =>
              prev && prev.id === id
                ? {
                    ...prev,
                    flamingo: bf.flamingo,
                    review: bf.breakdown || prev.review,
                    flamingoStatus: "complete",
                  }
                : prev
            )
          );
        }
        return;
      }
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this analysis and its stored audio?")) return;
    await fetch(`/api/uploads/${id}`, { method: "DELETE" });
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
    }
    setItems((prev) => (prev || []).filter((x) => x.id !== id));
  }

  return (
    <div className="up-page">
      <div className="up-hero">
        <div className="up-hero-inner">
          <div className="up-topnav">
            <Link href="/" className="up-navlink">
              ← home
            </Link>
            <Link href="/upload" className="up-navlink lib">
              + analyze a new track
            </Link>
          </div>
          <span className="up-eyebrow">Studio</span>
          <h1>🎚️ Your track library</h1>
          <p>
            Every track you&apos;ve analyzed — saved with its full X-ray and
            playable audio.
          </p>
        </div>
      </div>

      <div className="up-body">
        {/* 🔎 search by sound — natural language → CLAP → nearest tracks */}
        <form className="sonic-search" onSubmit={search}>
          <input
            className="sonic-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="🔎 Search by sound — e.g. “warm nocturnal piano, sparse and melancholic”"
          />
          <button className="btn" type="submit" disabled={searching}>
            {searching ? "…" : "Search"}
          </button>
          {hits !== null && (
            <button
              type="button"
              className="sonic-clear"
              onClick={() => {
                setQ("");
                setHits(null);
              }}
            >
              clear
            </button>
          )}
        </form>

        {hits !== null && (
          <div className="sonic-results">
            <div className="stat-label" style={{ marginBottom: 6 }}>
              {hits.length
                ? `🧬 Sounds like “${q}”`
                : `No close matches for “${q}” yet — try a different description or analyze more tracks.`}
            </div>
            {hits.map((h, i) => (
              <div
                key={h.id}
                className={`lib-item${openId === h.id ? " open" : ""}`}
              >
                <div className="lib-row" onClick={() => open(h.id)}>
                  <div className="lib-main">
                    <div className="lib-title">
                      <span className="sonic-rank">{i + 1}</span> {h.title}
                    </div>
                    <div className="lib-sub muted">
                      {[h.key, h.tempo ? `${h.tempo} BPM` : ""]
                        .filter(Boolean)
                        .join(" · ")}
                      {typeof h.distance === "number" && (
                        <span className="sonic-score">
                          {" "}
                          · {Math.round((1 - h.distance) * 100)}% match
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="lib-caret">
                    {openId === h.id ? "▲" : "▼"}
                  </span>
                </div>
                {openId === h.id && (
                  <div className="lib-detail">
                    {loadingDetail && (
                      <p className="muted">
                        <span className="spinner" /> loading analysis…
                      </p>
                    )}
                    {detail && detail.id === h.id && (
                      <AnalysisResult
                        data={detail}
                        audioSrc={`/api/uploads/${h.id}/audio`}
                        trackId={h.id}
                      />
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="notice" style={{ marginTop: 16 }}>
            Error: {error}
          </div>
        )}
        {!items && (
          <p className="muted" style={{ marginTop: 20 }}>
            <span className="spinner" /> loading…
          </p>
        )}
        {items && items.length === 0 && !error && (
          <div className="lib-empty">
            No tracks yet.{" "}
            <Link href="/upload" className="lib-link">
              Analyze your first one →
            </Link>
          </div>
        )}

        <div className="lib-list">
          {(items || []).map((it) => (
            <div
              key={it.id}
              className={`lib-item${openId === it.id ? " open" : ""}`}
            >
              <div className="lib-row" onClick={() => open(it.id)}>
                <div className="lib-main">
                  <div className="lib-title">{it.title}</div>
                  <div className="lib-sub muted">
                    {it.analysisStatus === "analyzing" ? (
                      <span className="lib-analyzing">
                        <span className="spinner" /> analyzing…
                      </span>
                    ) : (
                      [
                        it.key,
                        it.tempo ? `${it.tempo} BPM` : "",
                        fmtDate(it.createdAt),
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    )}
                  </div>
                </div>
                <span className="lib-caret">{openId === it.id ? "▲" : "▼"}</span>
                <button
                  className="lib-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(it.id);
                  }}
                  title="Delete"
                >
                  🗑
                </button>
              </div>
              {openId === it.id && (
                <div className="lib-detail">
                  {loadingDetail && (
                    <p className="muted">
                      <span className="spinner" /> loading analysis…
                    </p>
                  )}
                  {detail &&
                    detail.id === it.id &&
                    detail.analysisStatus === "analyzing" && (
                      <div className="flamingo-pending">
                        <span className="spinner" />
                        <span>
                          Analyzing the whole track — key, tempo, chords, the
                          structure &amp; energy map, and a grounded review. This
                          updates automatically when it&apos;s done; you can leave
                          this page and it keeps going.
                        </span>
                      </div>
                    )}
                  {detail &&
                    detail.id === it.id &&
                    detail.analysisStatus !== "analyzing" && (
                      <AnalysisResult
                        data={detail}
                        audioSrc={`/api/uploads/${it.id}/audio`}
                        trackId={it.id}
                      />
                    )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
