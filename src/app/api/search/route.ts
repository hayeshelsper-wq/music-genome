import { NextRequest, NextResponse } from "next/server";
import { searchArtists } from "@/lib/musicbrainz";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ artists: [] });
  try {
    const artists = await searchArtists(q);
    return NextResponse.json({ artists });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
