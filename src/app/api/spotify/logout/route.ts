import { NextResponse } from "next/server";
import { appOrigin, clearTokenCookies } from "@/lib/spotify";

export const dynamic = "force-dynamic";

export async function GET() {
  const res = NextResponse.redirect(new URL("/playlists", appOrigin()));
  clearTokenCookies(res);
  return res;
}
