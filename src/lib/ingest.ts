import { withSession, ensureConstraints } from "./neo4j";
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

/** Pull from every source and write the graph. Idempotent via MERGE. */
export async function ingestArtist(mbid: string): Promise<void> {
  await ensureConstraints();
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

  const influenceRows = influences.map((i) => ({
    key: i.mbid || `wd:${i.qid}`,
    name: i.name,
    qid: i.qid,
    dir: i.direction,
  }));

  const collabRows = (relations || [])
    .filter((r: MbRelation) => r.artist?.id)
    .map((r) => {
      const c = classify(r.type);
      return { key: r.artist!.id, name: r.artist!.name, kind: c.kind, label: c.label };
    });

  await withSession(async (s) => {
    await s.run(
      `MERGE (a:Artist {mbid:$mbid})
       SET a.name=$name, a.country=$country, a.type=$type,
           a.beginYear=$beginYear, a.endYear=$endYear, a.wikidataId=$wikidataId,
           a.timelineJson=$timelineJson, a.similarJson=$similarJson,
           a.tagsJson=$tagsJson, a.ingestedAt=timestamp(), a.source='musicbrainz'`,
      {
        mbid,
        name: ref.name,
        country: ref.country ?? null,
        type: ref.type ?? null,
        beginYear: ref.beginYear ?? null,
        endYear: ref.endYear ?? null,
        wikidataId: ref.wikidataId ?? null,
        timelineJson: JSON.stringify(timeline),
        similarJson: JSON.stringify(similar),
        tagsJson: JSON.stringify(tags),
      }
    );

    if (influenceRows.length) {
      await s.run(
        `UNWIND $rows AS row
         MERGE (o:Artist {mbid: row.key})
           ON CREATE SET o.name = row.name, o.wikidataId = row.qid, o.source='wikidata'
           ON MATCH SET o.name = coalesce(o.name, row.name)
         WITH o, row
         MATCH (a:Artist {mbid:$root})
         FOREACH (_ IN CASE WHEN row.dir='influence' THEN [1] ELSE [] END |
                  MERGE (a)-[:INFLUENCED_BY]->(o))
         FOREACH (_ IN CASE WHEN row.dir='descendant' THEN [1] ELSE [] END |
                  MERGE (o)-[:INFLUENCED_BY]->(a))`,
        { rows: influenceRows, root: mbid }
      );
    }

    if (collabRows.length) {
      await s.run(
        `UNWIND $rows AS row
         MERGE (o:Artist {mbid: row.key})
           ON CREATE SET o.name = row.name, o.source='musicbrainz'
           ON MATCH SET o.name = coalesce(o.name, row.name)
         WITH o, row
         MATCH (a:Artist {mbid:$root})
         MERGE (a)-[r:RELATED {kind: row.kind}]->(o)
           SET r.label = row.label`,
        { rows: collabRows, root: mbid }
      );
    }
  });
}

/** Assemble the report by reading the graph back out. */
export async function buildReport(mbid: string): Promise<ArtistDnaReport> {
  return withSession(async (s) => {
    const root = await s.run(`MATCH (a:Artist {mbid:$mbid}) RETURN a`, { mbid });
    if (root.records.length === 0) throw new Error("artist not ingested");
    const a = root.records[0].get("a").properties;

    const inf = await s.run(
      `MATCH (a:Artist {mbid:$mbid})
       OPTIONAL MATCH (a)-[:INFLUENCED_BY]->(up:Artist)
       OPTIONAL MATCH (down:Artist)-[:INFLUENCED_BY]->(a)
       RETURN
         collect(DISTINCT {mbid:up.mbid, name:up.name}) AS influences,
         collect(DISTINCT {mbid:down.mbid, name:down.name}) AS descendants`,
      { mbid }
    );
    const rec = inf.records[0];
    const influences = (rec.get("influences") || []).filter((x: any) => x.name);
    const descendants = (rec.get("descendants") || []).filter((x: any) => x.name);

    const col = await s.run(
      `MATCH (a:Artist {mbid:$mbid})-[r:RELATED]->(o:Artist)
       RETURN collect({mbid:o.mbid, name:o.name, kind:r.kind, label:r.label}) AS collabs`,
      { mbid }
    );
    const collabs = col.records[0].get("collabs") || [];

    // ---- family tree graph ----
    const famNodes: GraphNode[] = [
      { id: a.mbid, name: a.name, group: "root" },
    ];
    const famLinks: GraphLink[] = [];
    for (const x of influences) {
      famNodes.push({ id: x.mbid, name: x.name, group: "influence" });
      famLinks.push({ source: a.mbid, target: x.mbid, kind: "INFLUENCED_BY", label: "influenced by" });
    }
    for (const x of descendants) {
      famNodes.push({ id: x.mbid, name: x.name, group: "descendant" });
      famLinks.push({ source: x.mbid, target: a.mbid, kind: "INFLUENCED_BY", label: "influenced" });
    }

    // ---- collaborator graph ----
    const colNodes: GraphNode[] = [{ id: a.mbid, name: a.name, group: "root" }];
    const colLinks: GraphLink[] = [];
    for (const c of collabs) {
      colNodes.push({ id: c.mbid, name: c.name, group: "collaborator", detail: c.label });
      colLinks.push({ source: a.mbid, target: c.mbid, kind: c.kind, label: c.label });
    }

    return {
      artist: {
        mbid: a.mbid,
        name: a.name,
        country: a.country ?? undefined,
        type: a.type ?? undefined,
        beginYear: a.beginYear ?? undefined,
        endYear: a.endYear ?? undefined,
        wikidataId: a.wikidataId ?? undefined,
      },
      family: { nodes: dedupeNodes(famNodes), links: famLinks },
      collaborators: { nodes: dedupeNodes(colNodes), links: colLinks },
      similar: JSON.parse(a.similarJson || "[]"),
      tags: JSON.parse(a.tagsJson || "[]"),
      timeline: JSON.parse(a.timelineJson || "[]") as GenrePoint[],
    };
  });
}

function dedupeNodes(nodes: GraphNode[]): GraphNode[] {
  const map = new Map<string, GraphNode>();
  for (const n of nodes) if (n.id && !map.has(n.id)) map.set(n.id, n);
  return [...map.values()];
}
