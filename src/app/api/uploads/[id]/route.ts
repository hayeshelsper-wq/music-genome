import { NextRequest, NextResponse } from "next/server";
import { getUpload, deleteUpload } from "@/lib/store";
import { deleteAudio } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const rec = await getUpload(id);
    if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(rec);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const rec = await deleteUpload(id);
    if (rec?.audioPath) await deleteAudio(rec.audioPath).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 500 }
    );
  }
}
