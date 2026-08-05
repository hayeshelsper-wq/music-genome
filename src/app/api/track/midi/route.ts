// Download a stored transcription as a .mid file.

import { NextRequest, NextResponse } from "next/server";
import { getSymbolic } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const scope = req.nextUrl.searchParams.get("scope");
  const key = req.nextUrl.searchParams.get("key") || "";
  if ((scope !== "uploads" && scope !== "xrays") || !key) {
    return NextResponse.json({ error: "scope and key required" }, { status: 400 });
  }
  const rec = await getSymbolic(scope, key);
  if (!rec?.midi_b64) {
    return NextResponse.json({ error: "no MIDI stored for this key" }, { status: 404 });
  }
  return new NextResponse(Buffer.from(rec.midi_b64, "base64") as unknown as BodyInit, {
    headers: {
      "Content-Type": "audio/midi",
      "Content-Disposition": 'attachment; filename="melody.mid"',
      "Cache-Control": "private, max-age=3600",
    },
  });
}
