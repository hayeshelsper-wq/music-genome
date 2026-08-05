// Promptable sound extraction (SAM Audio): "isolate the tambourine" on a
// preview or library upload. Cached by sha1(source|text|span); cold GPU
// returns 202 {warming:true} and the client polls (Flamingo requireWarm UX).

import { NextRequest, NextResponse } from "next/server";
import { runExtraction } from "@/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: {
    previewUrl?: string;
    uploadId?: string;
    text?: string;
    spanStart?: number;
    spanEnd?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.text?.trim()) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }
  try {
    const result = await runExtraction({
      previewUrl: body.previewUrl,
      uploadId: body.uploadId,
      text: body.text,
      spanStart: body.spanStart,
      spanEnd: body.spanEnd,
    });
    if ("warming" in result) {
      return NextResponse.json(result, { status: 202 });
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "extraction failed" },
      { status: 502 }
    );
  }
}
