// Pre-rendered Song X-Rays available for instant viewing (the showcase).
import { NextResponse } from "next/server";
import { listXray } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const songs = await listXray(12).catch(() => []);
  return NextResponse.json({ songs });
}
