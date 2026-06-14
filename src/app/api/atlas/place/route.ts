// "Drop your own track onto the map": place a library upload in the Living Map's
// 2D space by finding its nearest landmark tracks in CLAP space and taking the
// similarity-weighted position of those neighbors.

import { NextRequest, NextResponse } from "next/server";
import { getUpload, getUploadVector } from "@/lib/store";
import corpus from "@/data/musicMapEmbeddings.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CorpusPoint { id: string; title: string; artist: string; x: number; y: number; vec: number[] }
const POINTS = corpus as CorpusPoint[];

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const d = Math.min(a.length, b.length);
  for (let i = 0; i < d; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export async function POST(req: NextRequest) {
  let body: { uploadId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const uploadId = body.uploadId;
  if (!uploadId) return NextResponse.json({ error: "uploadId required" }, { status: 400 });
  if (!POINTS.length) return NextResponse.json({ error: "the map corpus isn't built yet" }, { status: 503 });

  const [rec, vec] = await Promise.all([getUpload(uploadId), getUploadVector(uploadId)]);
  if (!vec) return NextResponse.json({ error: "that track has no CLAP embedding (not analyzed yet)" }, { status: 400 });

  const scored = POINTS.map((p) => ({ p, sim: cosine(vec, p.vec) })).sort((a, b) => b.sim - a.sim);
  const top = scored.slice(0, 6);

  // similarity-weighted centroid (emphasize the closest neighbors)
  let wx = 0, wy = 0, wsum = 0;
  for (const { p, sim } of top) { const w = Math.max(0, sim) ** 3; wx += w * p.x; wy += w * p.y; wsum += w; }
  const x = wsum ? wx / wsum : 0.5;
  const y = wsum ? wy / wsum : 0.5;

  return NextResponse.json({
    title: rec?.title || "Your track",
    x: Math.round(x * 1e4) / 1e4,
    y: Math.round(y * 1e4) / 1e4,
    neighbors: top.slice(0, 3).map(({ p, sim }) => ({ title: p.title, artist: p.artist, similarity: sim })),
  });
}
