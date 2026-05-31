// AcousticBrainz — community-computed audio features keyed by MusicBrainz
// *recording* MBID. Free, open, no auth. Data collection froze in 2022 but the
// API and its millions of precomputed analyses are still live, so coverage is
// strong for established catalog and thinner for very new/obscure tracks.
//
// This is the post-Spotify replacement for the deprecated Audio Features API:
// we already key everything by MBID, so it grafts straight onto the graph.
//
// We aggregate per-track analyses into one "Sonic DNA" profile for the artist:
// typical tempo, prevailing key, danceability, and mood mix.

const BASE = "https://acousticbrainz.org/api/v1";
const CHUNK = 25; // max recording_ids per bulk request
// AcousticBrainz is a frozen, slowly-degrading service with very swingy latency
// (measured 4s on a good run, >14s on a bad one). A too-tight cap aborts every
// request and the profile silently vanishes, so we give each try real headroom
// AND retry once (below) — the call is best-effort and fades in, so a slower
// response just means the stats appear a beat later rather than never.
// Measured live: AcousticBrainz answers successfully but swings 7s-12s. A 10s
// cap aborted the slow-but-fine responses; 15s comfortably clears its real range.
const TIMEOUT_MS = 15000;
const RETRIES = 1; // and retry once for the rare outright failure

export interface AudioProfile {
  /** How many of the artist's recordings actually had AcousticBrainz data. */
  sampleSize: number;
  avgBpm: number | null;
  /** Most common musical keys across the sampled recordings. */
  keys: { key: string; count: number }[];
  /** 0..1, averaged probability that tracks are "danceable". */
  danceability: number | null;
  /** Averaged mood probabilities (e.g. happy, sad, aggressive, relaxed). */
  moods: { name: string; score: number }[];
  /** Top genre labels from the high-level genre classifiers. */
  genres: { name: string; score: number }[];
}

// ---- raw response shapes (only the fields we read) -------------------------
interface HighLevelDoc {
  highlevel?: Record<
    string,
    { value?: string; probability?: number; all?: Record<string, number> }
  >;
}
interface LowLevelDoc {
  rhythm?: { bpm?: number };
  tonal?: { key_key?: string; key_scale?: string };
}
type Bulk<T> = Record<string, Record<string, T>>;

async function bulk<T>(
  endpoint: "high-level" | "low-level",
  ids: string[],
  chunkSize: number = CHUNK
): Promise<Bulk<T>> {
  // Fetch every chunk concurrently and bound each request so a slow or
  // unreachable AcousticBrainz never hangs the report — we just return what
  // arrived in time and the profile degrades to "previews only". low-level docs
  // are huge (full spectral analysis), so callers pass a small chunkSize to keep
  // each request fast and resilient rather than one giant slow payload.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));

  const fetchChunk = async (slice: string[]): Promise<Bulk<T> | null> => {
    const url = `${BASE}/${endpoint}?recording_ids=${slice.join(";")}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      return (await res.json()) as Bulk<T>;
    } catch {
      return null; // timeout or network error
    } finally {
      clearTimeout(timer);
    }
  };

  const responses = await Promise.all(
    chunks.map(async (slice) => {
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        const r = await fetchChunk(slice);
        if (r) return r;
      }
      return null; // exhausted retries — skip this chunk, profile degrades
    })
  );

  const out: Bulk<T> = {};
  for (const data of responses) if (data) Object.assign(out, data);
  return out;
}

// The bulk endpoints nest each recording under a submission offset ("0", "1"…).
// We just take the first available submission for each recording.
function firstDoc<T>(byOffset: Record<string, T> | undefined): T | undefined {
  if (!byOffset) return undefined;
  const k = Object.keys(byOffset)[0];
  return k ? byOffset[k] : undefined;
}

const MOOD_CLASSIFIERS: Record<string, string> = {
  mood_happy: "happy",
  mood_sad: "sad",
  mood_aggressive: "aggressive",
  mood_relaxed: "relaxed",
  mood_party: "party",
  mood_acoustic: "acoustic",
  mood_electronic: "electronic",
};

/**
 * Pull audio features for a set of recording MBIDs and fold them into a single
 * artist-level profile. Returns null if AcousticBrainz has nothing for any of
 * them (common for very new or very obscure artists).
 */
export async function aggregateAudioProfile(
  recordingIds: string[],
  max = 50
): Promise<AudioProfile | null> {
  const ids = recordingIds.slice(0, max);
  if (ids.length === 0) return null;

  // High-level docs are small, so we can afford to scan a wide net to *find*
  // the handful of recordings AcousticBrainz actually analyzed. Low-level docs
  // (full spectral analysis — BPM, key) are huge, so we only fetch them for the
  // recordings we already know have data.
  const high = await bulk<HighLevelDoc>("high-level", ids);
  const hitIds = ids.filter((id) => firstDoc(high[id])?.highlevel);
  if (hitIds.length === 0) return null;

  // Small chunks (4 ids) so each low-level request — they're large — stays fast
  // and a single slow one doesn't sink the whole tempo/key result.
  const low = await bulk<LowLevelDoc>("low-level", hitIds.slice(0, 16), 4);

  const bpms: number[] = [];
  const keyCounts = new Map<string, number>();
  const danceVals: number[] = [];
  const moodSums = new Map<string, { sum: number; n: number }>();
  const genreSums = new Map<string, { sum: number; n: number }>();
  const analyzed = new Set<string>();

  for (const id of ids) {
    const ll = firstDoc(low[id]);
    if (ll?.rhythm?.bpm && Number.isFinite(ll.rhythm.bpm)) {
      bpms.push(ll.rhythm.bpm);
      analyzed.add(id);
    }
    if (ll?.tonal?.key_key) {
      const key = `${ll.tonal.key_key} ${ll.tonal.key_scale ?? ""}`.trim();
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }

    const hl = firstDoc(high[id])?.highlevel;
    if (hl) {
      analyzed.add(id);
      const dance = hl.danceability?.all?.danceable;
      if (typeof dance === "number") danceVals.push(dance);

      for (const [classifier, label] of Object.entries(MOOD_CLASSIFIERS)) {
        const all = hl[classifier]?.all;
        if (!all) continue;
        // positive class is keyed by the mood word (e.g. all.happy)
        const positive = all[label];
        if (typeof positive === "number") {
          const acc = moodSums.get(label) ?? { sum: 0, n: 0 };
          acc.sum += positive;
          acc.n += 1;
          moodSums.set(label, acc);
        }
      }

      // genre_* classifiers expose a winning label + probability
      for (const [name, doc] of Object.entries(hl)) {
        if (!name.startsWith("genre_") || !doc.value) continue;
        const acc = genreSums.get(doc.value) ?? { sum: 0, n: 0 };
        acc.sum += doc.probability ?? 0;
        acc.n += 1;
        genreSums.set(doc.value, acc);
      }
    }
  }

  if (analyzed.size === 0) return null;

  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

  const moods = [...moodSums.entries()]
    .map(([name, { sum, n }]) => ({ name, score: sum / n }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const genres = [...genreSums.entries()]
    .map(([name, { sum, n }]) => ({ name, score: sum / n }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const keys = [...keyCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  const avg = mean(bpms);

  return {
    sampleSize: analyzed.size,
    avgBpm: avg !== null ? Math.round(avg) : null,
    keys,
    danceability: mean(danceVals),
    moods,
    genres,
  };
}
