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
    genres?: Array<{ name: string; count: number }>;
  }>;
}

/** Studio albums in chronological order, with their community genres. */
export async function getReleaseGroups(mbid: string): Promise<ReleaseGroup[]> {
  const d = await mb<MbReleaseGroupBrowse>("/release-group", {
    artist: mbid,
    type: "album",
    inc: "genres",
    limit: "100",
  });
  return (d["release-groups"] || [])
    .map((rg) => ({
      title: rg.title,
      year: year(rg["first-release-date"]),
      primaryType: rg["primary-type"],
      genres: (rg.genres || [])
        .sort((a, b) => b.count - a.count)
        .slice(0, 4)
        .map((g) => g.name),
    }))
    .filter((rg) => rg.year && rg.primaryType === "Album")
    .sort((a, b) => (a.year! - b.year!));
}
