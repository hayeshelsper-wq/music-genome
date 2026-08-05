// LoRA "voices": list them, and queue training on the user's OWN uploads.
// Own-uploads-only is a hard rule — every id must resolve via getUpload, and
// there is no path that trains on preview URLs or external audio.

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getUpload, listLoras, saveLora, patchLora } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REGION = process.env.LORA_JOB_REGION || "us-central1";
const JOB_NAME = process.env.LORA_JOB_NAME || "lora-trainer";

export async function GET() {
  try {
    return NextResponse.json({ loras: await listLoras() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 502 }
    );
  }
}

async function triggerJob(loraId: string): Promise<void> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error("jobs unavailable locally");
  const { JobsClient } = await import("@google-cloud/run");
  const client = new JobsClient();
  await client.runJob({
    name: `projects/${project}/locations/${REGION}/jobs/${JOB_NAME}`,
    overrides: {
      containerOverrides: [{ env: [{ name: "LORA_ID", value: loraId }] }],
    },
  });
}

export async function POST(req: NextRequest) {
  let body: { label?: string; uploadIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const label = (body.label || "").trim();
  const uploadIds = Array.isArray(body.uploadIds) ? body.uploadIds : [];
  if (!label) return NextResponse.json({ error: "label required" }, { status: 400 });
  if (uploadIds.length < 1) {
    return NextResponse.json({ error: "pick at least one of your uploads" }, { status: 400 });
  }

  // Validate every id against the library — reject anything that isn't the
  // user's own upload.
  const checks = await Promise.all(uploadIds.map((id) => getUpload(id)));
  const missing = uploadIds.filter((_, i) => !checks[i]);
  if (missing.length) {
    return NextResponse.json(
      { error: `not your uploads: ${missing.join(", ")}` },
      { status: 400 }
    );
  }

  const id = randomUUID();
  const bucket =
    process.env.UPLOADS_BUCKET ||
    (process.env.GOOGLE_CLOUD_PROJECT ? `${process.env.GOOGLE_CLOUD_PROJECT}-uploads` : "");
  try {
    await saveLora({
      id,
      label,
      ownerUploadIds: uploadIds,
      gcsPath: bucket ? `gs://${bucket}/loras/${id}` : "",
      baseModel: "acestep-v15-base",
      status: "queued",
      createdAt: Date.now(),
    });
    try {
      await triggerJob(id);
    } catch (e) {
      await patchLora(id, {
        status: "error",
        error: e instanceof Error ? e.message : "job trigger failed",
      });
    }
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 502 }
    );
  }
}
