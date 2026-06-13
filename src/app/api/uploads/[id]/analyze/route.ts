import { NextRequest, NextResponse } from "next/server";
import { getUpload, patchUpload } from "@/lib/store";
import { audioObject } from "@/lib/storage";
import { cloudRunAuthHeader } from "@/lib/cloudRun";
import { generateUploadReview } from "@/lib/uploadReview";

export const runtime = "nodejs";
export const maxDuration = 300;

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

// Resumable full-song analysis for an upload that's already persisted. Reads the
// stored audio back from GCS, runs the DSP + a warm-gated Flamingo + the grounded
// review, and patches the record to "complete". Idempotent: if it's already done,
// it returns the stored analysis. Driven by the upload page right after upload,
// and re-triggerable from the library if the page was closed mid-analysis.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const rec = await getUpload(id);
    if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Already analyzed → return what's stored (idempotent).
    if (rec.analysisStatus === "complete" && rec.features) {
      return NextResponse.json({
        id,
        title: rec.title,
        features: rec.features,
        sections: rec.sections,
        chromagram: rec.chromagram,
        breakdown: rec.review,
        flamingo: rec.flamingo || "",
        flamingoStatus: rec.flamingoStatus || "complete",
        model: rec.model,
        analysisStatus: "complete",
      });
    }

    // DSP + a warm-only Flamingo attempt (the audio-service gates on is_warm()).
    const [buf] = await audioObject(rec.audioPath).download();
    const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
    const fwd = new FormData();
    fwd.append(
      "file",
      new Blob([new Uint8Array(buf)], {
        type: rec.audioContentType || "audio/mpeg",
      }),
      rec.filename || "audio"
    );
    const res = await fetch(`${AUDIO_SERVICE}/upload`, {
      method: "POST",
      headers: { ...auth },
      body: fwd,
    });
    if (!res.ok)
      return NextResponse.json(
        { error: `audio-service ${res.status}` },
        { status: 502 }
      );
    const a = await res.json();
    const f = a.features;
    if (!f)
      return NextResponse.json(
        { error: a.error || "analysis failed" },
        { status: 500 }
      );

    const flamingo: string = a.flamingo || "";
    const sections = a.sections || [];
    const tags = a.tags ?? null;
    const { breakdown, model } = await generateUploadReview(
      f,
      sections,
      flamingo,
      rec.title,
      rec.artist || "",
      tags
    );
    // Warm GPU → Flamingo present → final review now. Cold GPU → provisional
    // DSP-only review + flamingoStatus pending; the client polls the Flamingo
    // backfill, which regenerates the review with Flamingo's read.
    const flamingoStatus = flamingo ? "complete" : "pending";

    await patchUpload(id, {
      features: f,
      sections,
      chromagram: a.chromagram || null,
      review: breakdown,
      flamingo,
      flamingoStatus,
      tags,
      embedding: Array.isArray(a.embedding) ? a.embedding : undefined,
      model,
      durationSec: f.duration_sec,
      key: f.key,
      tempo: f.tempo_bpm,
      analysisStatus: "complete",
    });

    return NextResponse.json({
      id,
      title: rec.title,
      features: f,
      sections,
      chromagram: a.chromagram || null,
      breakdown,
      flamingo,
      flamingoStatus,
      tags,
      model,
      analysisStatus: "complete",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 500 }
    );
  }
}
