import { NextResponse } from "next/server";
import { listUploads } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const items = await listUploads();
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json(
      { items: [], error: e instanceof Error ? e.message : "failed" },
      { status: 500 }
    );
  }
}
