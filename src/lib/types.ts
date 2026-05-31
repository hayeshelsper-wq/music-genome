// Shared domain types for the Artist DNA Report.

export interface ArtistRef {
  /** MusicBrainz ID — our canonical key across all sources. */
  mbid: string;
  name: string;
  disambiguation?: string;
  country?: string;
  /** "Group" | "Person" | etc. (MusicBrainz artist type) */
  type?: string;
  beginYear?: number;
  endYear?: number;
  /** Wikidata QID, when we can resolve one (drives the influence graph). */
  wikidataId?: string;
}

export type EdgeKind =
  | "INFLUENCED_BY" // directional, from Wikidata P737
  | "MEMBER_OF" // MusicBrainz band membership
  | "COLLABORATED_WITH" // MusicBrainz collaboration
  | "PRODUCED_BY" // MusicBrainz producer/engineer relation
  | "SIMILAR_TO"; // Last.fm "sounds like" (undirected proximity)

export interface GraphNode {
  id: string; // mbid or a synthetic id for non-MB people
  name: string;
  /** "root" for the searched artist, otherwise the relationship category. */
  group: "root" | "influence" | "descendant" | "collaborator" | "similar";
  detail?: string;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
}

export interface GenrePoint {
  year: number;
  /** Release-group (album) that anchors this point on the timeline. */
  release: string;
  genres: string[];
}

export interface ArtistDnaReport {
  artist: ArtistRef;
  /** Influence family tree (both directions), ready for force-graph. */
  family: { nodes: GraphNode[]; links: GraphLink[] };
  /** Collaborator / membership graph. */
  collaborators: { nodes: GraphNode[]; links: GraphLink[] };
  /** Last.fm adjacency + tags. */
  similar: { name: string; mbid?: string; match: number }[];
  tags: string[];
  /** Genre evolution over the discography. */
  timeline: GenrePoint[];
  /** LLM-written prose profile. Filled lazily by /api/artist/[id]/narrative. */
  narrative?: string;
}
