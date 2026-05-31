import { ArtistRef } from "./types";

const BASE = "https://musicbrainz.org/ws/2";

// MusicBrainz asks anonymous clients for <= 1 request/second. We serialize all
// calls through a single promise chain and space them out.
let chain: Promise<unknown> = Promise.resolve();
const MIN_GAP_MS = 1100;
let lastAt = 0;

function ua(): string {
  return (
    process.env.MUSICBRAINZ_USER_AGENT ||
    "MusicGenomeProject/0.1 ( example@example.com )"
  );
}

async function mb<T>(path: string, params: Record<string, string>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    const qs = new URLSearchParams({ ...params, fmt: "json" }).toString();
    const res = await fetch(`${BASE}${path}?${qs}`, {
      headers: { "User-Agent": ua() },
    });
    if (!res.ok) {
      throw new Error(`MusicBrainz ${path} -> ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  };
  // queue behind whatever is in flight
  const result = chain.then(run, run);
  chain = result.catch(() => {});
  return result as Promise<T>;
}

function year(date?: string): number | undefined {
  if (!date) return undefined;
  const y = parseInt(date.slice(0, 4), 10);
  return Number.isFinite(y) ? y : undefined;
}

interface MbArtistSearch {
  artists: Array<{
    id: string;
    name: string;
    disambiguation?: string;
    country?: string;
    type?: string;
    "life-span"?: { begin?: string; end?: string };
    score?: number;
  }>;
}

export async function searchArtists(query: string): Promise<ArtistRef[]> {
  const data = await mb<MbArtistSearch>("/artist", { query, limit: "8" });
  return (data.artists || []).map((a) => ({
    mbid: a.id,
    name: a.name,
    disambiguation: a.disambiguation,
    country: a.country,
    type: a.type,
    beginYear: year(a["life-span"]?.begin),
    endYear: year(a["life-span"]?.end),
  }));
}

export interface MbRelation {
  type: string; // "member of band", "collaboration", "producer", etc.
  direction: "forward" | "backward";
  artist?: { id: string; name: string; disambiguation?: string };
  url?: { resource: string };
}

interface MbArtistDetail {
  id: string;
  name: string;
  disambiguation?: string;
  country?: string;
  type?: string;
  "life-span"?: { begin?: string; end?: string };
  relations?: MbRelation[];
}

/** Artist with url-rels (to find Wikidata) and artist-rels (members/collabs). */
export async function getArtist(
  mbid: string
): Promise<{ ref: ArtistRef; relations: MbRelation[] }> {
  const d = await mb<MbArtistDetail>(`/artist/${mbid}`, {
    inc: "url-rels+artist-rels",
  });
  const wikidata = (d.relations || [])
    .map((r) => r.url?.resource || "")
    .find((u) => u.includes("wikidata.org"));
  const wikidataId = wikidata
    ? wikidata.split("/").filter(Boolean).pop()
    : undefined;
  return {
    ref: {
      mbid: d.id,
      name: d.name,
      disambiguation: d.disambiguation,
      country: d.country,
      type: d.type,
      beginYear: year(d["life-span"]?.begin),
      endYear: year(d["life-span"]?.end),
      wikidataId: wikidataId && /^Q\d+$/.test(wikidataId) ? wikidataId : undefined,
    },
    relations: d.relations || [],
  };
}

interface MbRecordingBrowse {
  recordings: Array<{ id: string; title: string; length?: number }>;
}

/**
 * Recording-level MBIDs for an artist — the keys we use to look up precomputed
 * audio features in AcousticBrainz. We intentionally keep *every* distinct
 * recording id (not deduped by title): a song can have many recording MBIDs
 * across releases, and only specific ones were ever analyzed, so a wider net
 * meaningfully improves AcousticBrainz hit-rate.
 */
export async function getArtistRecordings(
  mbid: string,
  limit = 100
): Promise<{ id: string; title: string }[]> {
  const d = await mb<MbRecordingBrowse>("/recording", {
    artist: mbid,
    limit: String(limit),
  });
  const seen = new Set<string>();
  const out: { id: string; title: string }[] = [];
  for (const r of d.recordings || []) {
    if (!r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, title: r.title });
  }
  return out;
}

export interface ReleaseGroup {
  title: string;
  year?: number;
  primaryType?: string;
  genres: string[];
}

interface MbReleaseGroupBrowse {
  "release-groups": Array<{
    title: string;
    "first-release-date"?: string;
    "primary-type"?: string;
    "secondary-types"?: string[];
    genres?: Array<{ name: string; count: number }>;
  }>;
}

/**
 * Studio albums in chronological order, with their community genres.
 * Excludes anything with a secondary type (compilation, live, remix,
 * soundtrack, DJ-mix, interview, demo…) so the genre timeline reflects the
 * actual artistic arc, not greatest-hits packages and live bootlegs.
 */
export async function getReleaseGroups(mbid: string): Promise<ReleaseGroup[]> {
  const d = await mb<MbReleaseGroupBrowse>("/release-group", {
    artist: mbid,
    type: "album",
    inc: "genres",
    limit: "100",
  });
  return (d["release-groups"] || [])
    .filter(
      (rg) =>
        rg["primary-type"] === "Album" &&
        (rg["secondary-types"]?.length ?? 0) === 0
    )
    .map((rg) => ({
      title: rg.title,
      year: year(rg["first-release-date"]),
      primaryType: rg["primary-type"],
      genres: (rg.genres || [])
        .sort((a, b) => b.count - a.count)
        .slice(0, 4)
        .map((g) => g.name),
    }))
    .filter((rg) => rg.year)
    .sort((a, b) => (a.year! - b.year!));
}

interface MbReleaseBrowse {
  releases: Array<{
    "release-group"?: { "primary-type"?: string; "secondary-types"?: string[] };
    media?: Array<{ tracks?: Array<{ recording?: { id: string } }> }>;
  }>;
}

/**
 * Recording MBIDs from the artist's official *studio albums* — the canonical
 * tracks AcousticBrainz actually analyzed. A blind /recording?artist browse is
 * mostly un-analyzed live/alt versions (~2% AcousticBrainz coverage for
 * Radiohead); studio-album tracks are ~96%, which is what makes "typical tempo /
 * prevailing keys" representative rather than a single random track.
 *
 * We page the artist's official album releases with their recordings AND their
 * release-groups in one browse each, then keep only releases whose group is a
 * pure studio album (primary Album, no secondary types) — dropping live albums,
 * compilations, remixes, and box sets. ~3 MusicBrainz calls total (vs one per
 * album), so it's fast and predictable; worth caching upstream regardless.
 */
export async function getStudioRecordingIds(
  mbid: string,
  pages = 3
): Promise<string[]> {
  const ids = new Set<string>();
  for (let page = 0; page < pages; page++) {
    let browse: MbReleaseBrowse;
    try {
      browse = await mb<MbReleaseBrowse>("/release", {
        artist: mbid,
        type: "album",
        status: "official",
        inc: "recordings+release-groups",
        limit: "100",
        offset: String(page * 100),
      });
    } catch {
      break; // keep whatever we've gathered so far
    }
    const releases = browse.releases || [];
    if (releases.length === 0) break;
    for (const r of releases) {
      const rg = r["release-group"];
      if (rg?.["primary-type"] !== "Album" || (rg?.["secondary-types"]?.length ?? 0) > 0) {
        continue; // skip live / compilation / remix / box-set releases
      }
      for (const m of r.media || []) {
        for (const t of m.tracks || []) {
          if (t.recording?.id) ids.add(t.recording.id);
        }
      }
    }
  }
  return [...ids];
}
