import { getUpload, patchUpload } from "@/lib/store";
import { audioObject } from "@/lib/storage";
import { cloudRunAuthHeader } from "@/lib/cloudRun";
import { generateUploadReview } from "@/lib/uploadReview";

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

// One Flamingo-backfill attempt for an upload whose GPU was cold. Shared by the
// client-polled route (/api/uploads/[id]/flamingo) AND the server-side sweeper
// (/api/cron/flamingo-sweep) so the analysis finishes + writes to the DB even if
// the user has navigated away. Idempotent. Returns "complete" once Flamingo lands,
// "pending" if the GPU is still cold (the caller retries), or "skip"/"error".
export type BackfillResult =
  | { status: "complete"; flamingo: string; breakdown: string }
  | { status: "pending" }
  | { status: "skip" }
  | { status: "error"; error: string };

export async function backfillUploadFlamingo(
  id: string,
  opts: { clipTimeoutMs?: number; force?: boolean } = {}
): Promise<BackfillResult> {
  try {
    const rec = await getUpload(id);
    if (!rec) return { status: "skip" };
    // already done — unless force, which re-runs Flamingo from scratch (used to
    // reprocess older uploads with the new full-track window instead of 30s).
    if (!opts.force && rec.flamingo && rec.flamingoStatus !== "pending") {
      return { status: "complete", flamingo: rec.flamingo, breakdown: rec.review };
    }

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
    // Cap the wait below the request budget so the caller (sweep) can return a
    // clean "pending" and retry next run rather than 504-ing itself on a cold GPU.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.clipTimeoutMs ?? 280_000);
    let flamingo = "";
    try {
      const r = await fetch(`${AUDIO_SERVICE}/flamingo-clip`, {
        method: "POST",
        headers: { ...auth },
        body: fwd,
        signal: ctrl.signal,
      });
      const j = r.ok ? await r.json() : {};
      flamingo = j.flamingo || "";
    } catch {
      flamingo = ""; // aborted/cold — stay pending
    } finally {
      clearTimeout(timer);
    }

    if (!flamingo) return { status: "pending" };

    const { breakdown, model } = await generateUploadReview(
      rec.features as Parameters<typeof generateUploadReview>[0],
      (rec.sections as Parameters<typeof generateUploadReview>[1]) || [],
      flamingo,
      rec.title,
      rec.artist || "",
      rec.tags ?? null
    );
    const review = breakdown || rec.review;
    // Merge-patch (not full set) so the stored embedding/tags/etc. are preserved.
    await patchUpload(id, {
      flamingo,
      review,
      model: model || rec.model,
      flamingoStatus: "complete",
    });
    return { status: "complete", flamingo, breakdown: review };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "failed" };
  }
}
