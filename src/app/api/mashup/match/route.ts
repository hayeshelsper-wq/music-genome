// Suggest sonically-compatible beds for a chosen track, by CLAP cosine over the
// Living-Map corpus (most similar texture → blends best in a mashup).

import { NextRequest, NextResponse } from "next/server";
import corpus from "@/data/musicMapEmbeddings.json";

export const dynamic = "force-dynamic";

interface CorpusPoint { id: string; title: string; artist: string; vec: number[] }
const POINTS = corpus as CorpusPoint[];

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const d = Math.min(a.length, b.length);
  for (let i = 0; i < d; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const self = POINTS.find((p) => p.id === id);
  if (!self) return NextResponse.json({ matches: [] });
  const ranked = POINTS
    .filter((p) => p.id !== id)
    .map((p) => ({ id: p.id, title: p.title, artist: p.artist, similarity: cosine(self.vec, p.vec) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 6);
  return NextResponse.json({ matches: ranked });
}
