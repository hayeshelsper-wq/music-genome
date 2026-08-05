// "Drop your own track onto the map": place a library upload in the Living Map's
// 2D space by finding its nearest landmark tracks in CLAP space and taking the
// similarity-weighted position of those neighbors.

import { NextRequest, NextResponse } from "next/server";
import { getUpload, getUploadVector } from "@/lib/store";
import { atlasReady, placeByVector } from "@/lib/atlas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { uploadId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const uploadId = body.uploadId;
  if (!uploadId) return NextResponse.json({ error: "uploadId required" }, { status: 400 });
  if (!atlasReady()) return NextResponse.json({ error: "the map corpus isn't built yet" }, { status: 503 });

  const [rec, vec] = await Promise.all([getUpload(uploadId), getUploadVector(uploadId)]);
  if (!vec) return NextResponse.json({ error: "that track has no CLAP embedding (not analyzed yet)" }, { status: 400 });

  const placed = placeByVector(vec);
  return NextResponse.json({ title: rec?.title || "Your track", ...placed });
}
