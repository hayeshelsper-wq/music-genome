// Wikidata is where directional influence actually lives: P737 ("influenced by").
// We query both directions in one shot — who influenced this artist, and who
// this artist went on to influence — and pull MusicBrainz ids (P434) so the
// nodes link back into our graph.

const SPARQL = "https://query.wikidata.org/sparql";

export interface InfluenceNode {
  qid: string;
  name: string;
  mbid?: string;
  direction: "influence" | "descendant";
}

interface SparqlResp {
  results: {
    bindings: Array<{
      other: { value: string };
      otherLabel?: { value: string };
      mbid?: { value: string };
      dir: { value: string };
    }>;
  };
}

export async function getInfluences(qid: string): Promise<InfluenceNode[]> {
  if (!/^Q\d+$/.test(qid)) return [];
  const query = `
    SELECT ?other ?otherLabel ?mbid ?dir WHERE {
      { wd:${qid} wdt:P737 ?other . BIND("influence" AS ?dir) }
      UNION
      { ?other wdt:P737 wd:${qid} . BIND("descendant" AS ?dir) }
      OPTIONAL { ?other wdt:P434 ?mbid . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 200`;
  const res = await fetch(`${SPARQL}?format=json&query=${encodeURIComponent(query)}`, {
    headers: {
      "User-Agent":
        process.env.MUSICBRAINZ_USER_AGENT || "MusicGenomeProject/0.1",
      Accept: "application/sparql-results+json",
    },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as SparqlResp;
  const seen = new Set<string>();
  const out: InfluenceNode[] = [];
  for (const b of data.results.bindings) {
    const qidOther = b.other.value.split("/").pop() || "";
    const key = qidOther + b.dir.value;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = b.otherLabel?.value || qidOther;
    // skip un-labeled QIDs (data quality noise)
    if (name === qidOther) continue;
    out.push({
      qid: qidOther,
      name,
      mbid: b.mbid?.value,
      direction: b.dir.value === "descendant" ? "descendant" : "influence",
    });
  }
  return out;
}
