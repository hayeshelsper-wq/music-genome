import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { getUpload } from "@/lib/store";
import { audioObject } from "@/lib/storage";

export const runtime = "nodejs";

// Streams the stored audio back from GCS (Range-aware, so <audio> can seek),
// keeping it behind the app's auth gate instead of exposing a public URL.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rec = await getUpload(id);
  if (!rec) return new NextResponse("not found", { status: 404 });

  const file = audioObject(rec.audioPath);
  const [meta] = await file.getMetadata();
  const size = Number(meta.size || 0);
  const contentType =
    rec.audioContentType || (meta.contentType as string) || "audio/mpeg";
  const range = req.headers.get("range");

  if (range && size) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    const node = file.createReadStream({ start, end });
    return new NextResponse(
      Readable.toWeb(node) as unknown as ReadableStream,
      {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Cache-Control": "private, max-age=3600",
        },
      }
    );
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
