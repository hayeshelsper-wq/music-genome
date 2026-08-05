// Mint a short-lived token for the crossfader's audio-service WS proxy. This
// route sits behind the site's password gate (middleware), so only logged-in
// sessions can get one.

import { NextResponse } from "next/server";
import { mintCrossfadeToken, crossfadeConfigured } from "@/lib/crossfadeToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!crossfadeConfigured()) {
    // Local dev without the secret: the proxy runs open too — return an empty
    // token so the client can still connect.
    return NextResponse.json({ token: "" });
  }
  return NextResponse.json({
    token: mintCrossfadeToken(process.env.CROSSFADE_TOKEN_SECRET as string),
  });
}
