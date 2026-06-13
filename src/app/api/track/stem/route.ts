import { NextRequest, NextResponse } from "next/server";
import { cloudRunAuthHeader } from "@/lib/cloudRun";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AUDIO = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

// Stream a Demucs stem file from the (private, IAM-only) audio-service to the
// browser. The browser can't reach the audio-service directly, so this proxy —
// served from the auth-gated web app, which holds the IAM creds — fetches it and
// pipes it back. Forwards Range requests so <audio> seeking works.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams.get("p");
  // Only proxy the stem-files path — never an arbitrary URL.
  if (!p || !p.startsWith("/stemfiles/")) {
    return new NextResponse("bad stem path", { status: 400 });
  }

  const auth = await cloudRunAuthHeader(AUDIO);
  const range = req.headers.get("range");
  const upstream = await fetch(`${AUDIO}${p}`, {
    headers: { ...auth, ...(range ? { Range: range } : {}) },
  });

  if (!upstream.ok && upstream.status !== 206) {
    return new NextResponse("stem not found", { status: upstream.status });
  }

  const headers = new Headers();
  headers.set(
    "Content-Type",
    upstream.headers.get("content-type") || "audio/wav"
  );
  for (const h of ["content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has("accept-ranges")) headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=600");

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers,
  });
}
