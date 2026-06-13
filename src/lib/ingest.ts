import { getReport, saveReport } from "./store";
import { getArtist, getReleaseGroups, MbRelation, ReleaseGroup } from "./musicbrainz";
import { getInfluences } from "./wikidata";
import { similarArtists, topTags } from "./lastfm";
import {
  ArtistDnaReport,
  EdgeKind,
  GenrePoint,
  GraphLink,
  GraphNode,
} from "./types";

function classify(relType: string): { kind: EdgeKind; label: string } {
  const t = relType.toLowerCase();
  if (t.includes("member")) return { kind: "MEMBER_OF", label: "member" };
  if (t.includes("producer") || t.includes("engineer") || t.includes("mix"))
    return { kind: "PRODUCED_BY", label: relType };
  return { kind: "COLLABORATED_WITH", label: relType };
}

function buildTimeline(rgs: ReleaseGroup[]): GenrePoint[] {
  return rgs
    .filter((rg) => rg.genres.length > 0)
    .map((rg) => ({ year: rg.year!, release: rg.title, genres: rg.genres }))
    .slice(0, 30);
}

function dedupeNodes(nodes: GraphNode[]): GraphNode[] {
  const map = new Map<string, GraphNode>();
  for (const n of nodes) if (n.id && !map.has(n.id)) map.set(n.id, n);
  return [...map.values()];
}

/**
 * Pull from every source, assemble the full report in memory, and persist it as
 * one document. Idempotent — re-ingesting just overwrites the doc. (The graphs
 * are 1-hop, so we build them directly here rather than round-tripping a DB.)
 */
export async function ingestArtist(mbid: string): Promise<void> {
  const { ref, relations } = await getArtist(mbid);
  const [releaseGroups, influences] = await Promise.all([
    getReleaseGroups(mbid),
    ref.wikidataId ? getInfluences(ref.wikidataId) : Promise.resolve([]),
  ]);
  const [similar, tags] = await Promise.all([
    similarArtists(ref.name),
    topTags(ref.name),
  ]);
  const timeline = buildTimeline(releaseGroups);

  // ---- family (influence) graph ----
  const famNodes: GraphNode[] = [{ id: ref.mbid, name: ref.name, group: "root" }];
  const famLinks: GraphLink[] = [];
  for (const i of influences) {
    const id = i.mbid || `wd:${i.qid}`;
    if (!i.name) continue;
    if (i.direction === "influence") {
      famNodes.push({ id, name: i.name, group: "influence" });
      famLinks.push({ source: ref.mbid, target: id, kind: "INFLUENCED_BY", label: "influenced by" });
    } else {
      famNodes.push({ id, name: i.name, group: "descendant" });
      famLinks.push({ source: id, target: ref.mbid, kind: "INFLUENCED_BY", label: "influenced" });
    }
  }

  // ---- collaborator graph ----
  const colNodes: GraphNode[] = [{ id: ref.mbid, name: ref.name, group: "root" }];
  const colLinks: GraphLink[] = [];
  const seenCol = new Set<string>();
  for (const r of (relations || []) as MbRelation[]) {
    if (!r.artist?.id) continue;
    const c = classify(r.type);
    const edgeKey = `${r.artist.id}|${c.kind}`;
    if (seenCol.has(edgeKey)) continue;
    seenCol.add(edgeKey);
    colNodes.push({ id: r.artist.id, name: r.artist.name, group: "collaborator", detail: c.label });
    colLinks.push({ source: ref.mbid, target: r.artist.id, kind: c.kind, label: c.label });
  }

  const report: ArtistDnaReport = {
    artist: ref,
    family: { nodes: dedupeNodes(famNodes), links: famLinks },
    collaborators: { nodes: dedupeNodes(colNodes), links: colLinks },
    similar,
    tags,
    timeline,
  };

  await saveReport(mbid, report);
}

/** Read the assembled report back out of the store. */
export async function buildReport(mbid: string): Promise<ArtistDnaReport> {
  const report = await getReport(mbid);
  if (!report) throw new Error("artist not ingested");
  return report;
}
