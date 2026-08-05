// Living-Map placement: project a CLAP vector into the map's 2D space via the
// similarity-weighted centroid of its nearest landmark tracks. Extracted from
// /api/atlas/place so hums and other vectors can be placed too.

import corpus from "@/data/musicMapEmbeddings.json";

interface CorpusPoint {
  id: string;
  title: string;
  artist: string;
  x: number;
  y: number;
  vec: number[];
}
const POINTS = corpus as CorpusPoint[];

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  const d = Math.min(a.length, b.length);
  for (let i = 0; i < d; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export interface MapPlacement {
  x: number;
  y: number;
  neighbors: { title: string; artist: string; similarity: number }[];
}

export function atlasReady(): boolean {
  return POINTS.length > 0;
}

export function placeByVector(vec: number[]): MapPlacement {
  const scored = POINTS.map((p) => ({ p, sim: cosine(vec, p.vec) })).sort(
    (a, b) => b.sim - a.sim
  );
  const top = scored.slice(0, 6);

  // similarity-weighted centroid (emphasize the closest neighbors)
  let wx = 0,
    wy = 0,
    wsum = 0;
  for (const { p, sim } of top) {
    const w = Math.max(0, sim) ** 3;
    wx += w * p.x;
    wy += w * p.y;
    wsum += w;
  }
  const x = wsum ? wx / wsum : 0.5;
  const y = wsum ? wy / wsum : 0.5;

  return {
    x: Math.round(x * 1e4) / 1e4,
    y: Math.round(y * 1e4) / 1e4,
    neighbors: top
      .slice(0, 3)
      .map(({ p, sim }) => ({ title: p.title, artist: p.artist, similarity: sim })),
  };
}
