// Streams a GCS object back to the browser (Range-aware, so <audio> can seek),
// restricted to the app-generated audio prefixes. Mirrors uploads/[id]/audio
// but is keyed by object path instead of an upload record.

import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { audioObject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_PREFIXES = ["studio-runs/", "extractions/", "hums/"];

function contentTypeFor(path: string): string {
  if (path.endsWith(".webm")) return "audio/webm";
  if (path.endsWith(".mp4") || path.endsWith(".m4a")) return "audio/mp4";
  return "audio/wav";
}

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path") || "";
  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p)) || path.includes("..")) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const file = audioObject(path);
  let size = 0;
  try {
    const [meta] = await file.getMetadata();
    size = Number(meta.size || 0);
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
  const contentType = contentTypeFor(path);
  const range = req.headers.get("range");

  if (range && size) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    const node = file.createReadStream({ start, end });
    return new NextResponse(Readable.toWeb(node) as unknown as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  const node = file.createReadStream();
  return new NextResponse(Readable.toWeb(node) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      ...(size ? { "Content-Length": String(size) } : {}),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
