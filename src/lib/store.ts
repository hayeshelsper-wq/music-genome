// Firestore-backed report store — the GCP-native replacement for Neo4j.
//
// Every query the app makes is a 1-hop lookup ("this artist's influences /
// collaborators / similar / tags / timeline"), so we don't need a graph database
// — we store the fully-assembled ArtistDnaReport as one document keyed by MBID.
// Firestore is serverless, scales to zero, costs ~nothing at demo scale, and has
// no idle-pause cold start (unlike Neo4j Aura Free).
//
// Auth: uses Application Default Credentials. On Cloud Run the service account is
// automatic; locally run `gcloud auth application-default login` (or point at the
// Firestore emulator via FIRESTORE_EMULATOR_HOST). Project id is auto-detected
// from ADC / the metadata server, or set GOOGLE_CLOUD_PROJECT.

import { Firestore, FieldValue } from "@google-cloud/firestore";
import { ArtistDnaReport } from "./types";
import { TagSet } from "./trackReview";

let db: Firestore | null = null;
function getDb(): Firestore {
  if (!db) db = new Firestore({ ignoreUndefinedProperties: true });
  return db;
}

const COLLECTION = process.env.FIRESTORE_COLLECTION || "artistReports";

export async function getReport(mbid: string): Promise<ArtistDnaReport | null> {
  const snap = await getDb().collection(COLLECTION).doc(mbid).get();
  if (!snap.exists) return null;
  return (snap.data()?.report as ArtistDnaReport) ?? null;
}

export async function saveReport(
  mbid: string,
  report: ArtistDnaReport
): Promise<void> {
  await getDb()
    .collection(COLLECTION)
    .doc(mbid)
    .set({ report, name: report.artist.name, ingestedAt: Date.now() });
}

export async function isIngested(mbid: string): Promise<boolean> {
  const snap = await getDb().collection(COLLECTION).doc(mbid).get();
  return snap.exists;
}

// ---- uploaded-track library (full-song analyses of user uploads) ----------

export interface UploadRecord {
  id: string;
  title: string;
  artist?: string;
  filename?: string;
  createdAt: number;
  audioPath: string; // GCS object path
  audioContentType: string;
  // analysisStatus gates the analysis: a record is created ("analyzing") the
  // moment the audio lands in storage, so it shows in the library immediately;
  // the DSP/review/Flamingo fill in later (resumable). "complete" once done.
  analysisStatus?: "analyzing" | "complete";
  features: unknown;
  sections: unknown[];
  chromagram: string | null;
  review: string;
  flamingo?: string;
  flamingoStatus?: string; // "complete" | "pending"
  tags?: TagSet | null; // discriminative instrument/genre/mood/vocal tags
  embedding?: number[]; // CLAP audio vector (stored as a Firestore vector field)
  model: string;
  durationSec?: number;
  key?: string;
  tempo?: number;
}

const UPLOADS = process.env.UPLOADS_COLLECTION || "uploads";

// A CLAP embedding must be stored as a Firestore *vector* (FieldValue.vector) for
// findNearest KNN — a plain array won't index. Convert on write.
function withVector(data: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(data.embedding)) {
    return { ...data, embedding: FieldValue.vector(data.embedding as number[]) };
  }
  return data;
}

export async function saveUpload(rec: UploadRecord): Promise<void> {
  await getDb().collection(UPLOADS).doc(rec.id).set(withVector({ ...rec }));
}

/** Merge-patch an existing upload record (used to fill in the analysis once it
 *  finishes, without re-writing the whole document). */
export async function patchUpload(
  id: string,
  patch: Partial<UploadRecord>
): Promise<void> {
  await getDb()
    .collection(UPLOADS)
    .doc(id)
    .set(withVector({ ...patch }), { merge: true });
}

/** Lightweight list for the library grid — projects out the heavy fields
 *  (chromagram/features) so the list stays small. */
export async function listUploads(
  limit = 200
): Promise<Partial<UploadRecord>[]> {
  const snap = await getDb()
    .collection(UPLOADS)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .select(
      "id",
      "title",
      "filename",
      "createdAt",
      "key",
      "tempo",
      "durationSec",
      "analysisStatus"
    )
    .get();
  return snap.docs.map((d) => d.data() as Partial<UploadRecord>);
}

/** Uploads whose Flamingo read is still pending (for the server-side sweeper).
 *  Single equality filter → no composite index needed; analysisStatus is checked
 *  in code so we only retry records whose DSP analysis already finished. */
export async function listPendingFlamingo(limit = 10): Promise<string[]> {
  const snap = await getDb()
    .collection(UPLOADS)
    .where("flamingoStatus", "==", "pending")
    .limit(limit)
    .get();
  return snap.docs
    .filter((d) => (d.data() as UploadRecord).analysisStatus === "complete")
    .map((d) => d.id); // the Firestore doc id IS the record id (reliable)
}

/** Analyzed uploads that don't yet have a CLAP vector (for the embed backfill).
 *  Covers "complete" records AND legacy ones (analyzed before analysisStatus
 *  existed) — anything with features but no embedding. */
export async function listMissingEmbedding(
  limit = 50,
  includeAll = false // re-embed everything (model migration), not just missing
): Promise<string[]> {
  const snap = await getDb().collection(UPLOADS).limit(limit).get();
  return snap.docs
    .filter((d) => {
      const data = d.data() as Record<string, unknown>;
      const analyzed = data.analysisStatus === "complete" || !!data.features;
      if (!analyzed) return false;
      return includeAll || !data.embedding;
    })
    .map((d) => d.id);
}

export async function getUpload(id: string): Promise<UploadRecord | null> {
  const snap = await getDb().collection(UPLOADS).doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data() as UploadRecord;
  // The stored embedding is a Firestore VectorValue, not JSON-serializable for
  // the client — drop it from the record API consumers see.
  delete (data as { embedding?: unknown }).embedding;
  return data;
}

/** Read a stored track's CLAP vector (for "Sonic Twins" audio→audio search). */
export async function getUploadVector(id: string): Promise<number[] | null> {
  const snap = await getDb().collection(UPLOADS).doc(id).get();
  const v = snap.exists
    ? (snap.data() as { embedding?: { toArray?: () => number[] } }).embedding
    : null;
  return v && typeof v.toArray === "function" ? v.toArray() : null;
}

export interface SonicHit {
  id: string;
  title: string;
  key?: string;
  tempo?: number;
  distance?: number;
}

/** KNN over the CLAP vectors — powers both text "search by sound" (pass a CLAP
 *  text vector) and "Sonic Twins" (pass a track's own audio vector). */
export async function findNearestUploads(
  queryVector: number[],
  limit = 12,
  excludeId?: string
): Promise<SonicHit[]> {
  const snap = await getDb()
    .collection(UPLOADS)
    .findNearest({
      vectorField: "embedding",
      queryVector: FieldValue.vector(queryVector),
      limit: excludeId ? limit + 1 : limit,
      distanceMeasure: "COSINE",
      distanceResultField: "_dist",
    })
    .get();
  return snap.docs
    .map((d) => {
      const r = d.data() as UploadRecord & { _dist?: number };
      return {
        id: d.id,
        title: r.title,
        key: r.key,
        tempo: r.tempo,
        distance: r._dist,
      } as SonicHit;
    })
    .filter((h) => h.id !== excludeId)
    .slice(0, limit);
}

export async function deleteUpload(id: string): Promise<UploadRecord | null> {
  const rec = await getUpload(id);
  await getDb().collection(UPLOADS).doc(id).delete();
  return rec;
}

// ---- artist sonic fingerprint (Influence Trails) --------------------------
// A per-artist sonic profile (CLAP centroid + aggregate DSP over their top
// tracks), cached so repeat trails are instant. No KNN over artists, so the
// embedding is a plain array (not a Firestore vector).

export interface ArtistSonic {
  mbid: string;
  name: string;
  tempo_bpm?: number;
  brightness_hz?: number;
  brightness?: string;
  texture?: string;
  density?: string;
  dynamics?: string;
  energy_shape?: string;
  key?: string;
  tracks: { title: string; previewUrl: string; artworkUrl?: string }[];
  embedding: number[]; // CLAP centroid of the analyzed top tracks
  trackCount: number;
  computedAt: number;
}

const ARTIST_SONIC = process.env.ARTIST_SONIC_COLLECTION || "artistSonic";

export async function getArtistSonic(mbid: string): Promise<ArtistSonic | null> {
  const snap = await getDb().collection(ARTIST_SONIC).doc(mbid).get();
  return snap.exists ? (snap.data() as ArtistSonic) : null;
}

export async function saveArtistSonic(rec: ArtistSonic): Promise<void> {
  await getDb().collection(ARTIST_SONIC).doc(rec.mbid).set(rec);
}

/** Recently-fingerprinted artists for the homepage "explore" strip (artwork +
 *  measured stats). Drops the heavy embedding from the payload. */
export async function listArtistSonic(limit = 8): Promise<Omit<ArtistSonic, "embedding">[]> {
  const snap = await getDb()
    .collection(ARTIST_SONIC)
    .orderBy("computedAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => {
    const data = d.data() as ArtistSonic;
    const { embedding: _drop, ...rest } = data;
    void _drop;
    return rest;
  });
}

/** Count of ingested artist reports (a homepage stat). Best-effort. */
export async function countReports(): Promise<number> {
  try {
    const agg = await getDb().collection(COLLECTION).count().get();
    return agg.data().count;
  } catch {
    return 0;
  }
}

// ---- Song X-Ray cache (persistent) ----------------------------------------
// The full per-track analysis (librosa DSP + Essentia tags + lyrics + the Music
// Flamingo read + the Claude producer breakdown) is expensive — Flamingo alone
// is a cold GPU. The route-level cache is in-memory only (lost on every cold
// Cloud Run instance), so we persist completed X-Rays here keyed by artist+title.
// Once a song is computed with Flamingo, every future view is instant — no GPU.

const XRAY = process.env.XRAY_COLLECTION || "xrayCache";

export function xrayKey(artist: string, title: string): string {
  return `${artist}|${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 256) || "untitled";
}

export async function getXray(
  artist: string,
  title: string
): Promise<Record<string, unknown> | null> {
  const snap = await getDb().collection(XRAY).doc(xrayKey(artist, title)).get();
  return snap.exists ? ((snap.data()?.result as Record<string, unknown>) ?? null) : null;
}

export async function saveXray(
  artist: string,
  title: string,
  result: Record<string, unknown>,
  extra: { previewUrl?: string; artwork?: string } = {}
): Promise<void> {
  await getDb()
    .collection(XRAY)
    .doc(xrayKey(artist, title))
    .set({
      artist,
      title,
      previewUrl: extra.previewUrl,
      artwork: extra.artwork,
      result,
      savedAt: Date.now(),
    });
}

export interface XrayListItem { artist: string; title: string; previewUrl?: string; artwork?: string }

/** Pre-rendered X-Rays for the showcase (metadata only, not the heavy result). */
export async function listXray(limit = 12): Promise<XrayListItem[]> {
  const snap = await getDb()
    .collection(XRAY)
    .orderBy("savedAt", "desc")
    .limit(limit)
    .select("artist", "title", "previewUrl", "artwork")
    .get();
  return snap.docs.map((d) => d.data() as XrayListItem);
}

export type StoreErrorCode = "unconfigured" | "unavailable" | "error";

/** Classify a Firestore failure so the UI shows the right thing: a setup prompt
 *  only when credentials/project are missing; a transient "retry" otherwise. */
export function classifyStoreError(e: unknown): StoreErrorCode {
  const m = `${(e as { message?: string })?.message || e} ${
    (e as { code?: string | number })?.code ?? ""
  }`;
  if (
    /detect a Project Id|default credentials|Could not (refresh|load)|invalid_grant|GOOGLE_APPLICATION_CREDENTIALS|PERMISSION_DENIED|UNAUTHENTICATED|permission|missing.*credential/i.test(
      m
    )
  )
    return "unconfigured";
  if (/UNAVAILABLE|DEADLINE_EXCEEDED|ECONNRESET|ECONNREFUSED|\b14\b|temporarily/i.test(m))
    return "unavailable";
  return "error";
}
