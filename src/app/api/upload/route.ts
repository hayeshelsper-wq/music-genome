import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { uploadAudio } from "@/lib/storage";
import { saveUpload } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 120;

// Persist FIRST, analyze later. We stash the audio in GCS and create the library
// record ("analyzing") right away, so the upload shows up in /library the instant
// the file lands — even if the user navigates away mid-analysis. The heavy DSP +
// review + Flamingo run as a separate, resumable step (POST /api/uploads/[id]/analyze),
// which reads the audio back from storage, so it works whether driven by the
// upload page or resumed later from the library.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File))
      return NextResponse.json({ error: "no file" }, { status: 400 });
    const title =
      (form.get("title") as string) || file.name || "Uploaded track";
    const artist = (form.get("artist") as string) || "";
    const buf = Buffer.from(await file.arrayBuffer());
    const contentType = file.type || "audio/mpeg";

    const id = randomUUID();
    const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] || ".mp3").toLowerCase();
    const audioPath = `uploads/${id}${ext}`;

    // 1) audio → GCS, 2) record → Firestore as "analyzing". Both must succeed
    // for the upload to be recoverable, so surface a failure rather than swallow it.
    await uploadAudio(audioPath, buf, contentType);
    await saveUpload({
      id,
      title,
      artist,
      filename: file.name,
      createdAt: Date.now(),
      audioPath,
      audioContentType: contentType,
      analysisStatus: "analyzing",
      flamingoStatus: "pending",
      features: null,
      sections: [],
      chromagram: null,
      review: "",
      model: "",
    });

    return NextResponse.json({ id, title, artist, analysisStatus: "analyzing" });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 500 }
    );
  }
}
