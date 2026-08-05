// Shared extraction logic for the route and the ask-agent tool: resolve the
// source audio, serve from the Firestore/GCS cache when possible, otherwise
// run SAM Audio and persist the result.

import { createHash } from "crypto";
import { getExtraction, saveExtraction, getUpload } from "./store";
import { readAudio, uploadAudio, signedOrProxyUrl } from "./storage";
import { samSeparate, samWarm, samConfigured } from "./samAudio";

export interface ExtractArgs {
  previewUrl?: string;
  uploadId?: string;
  text: string;
  spanStart?: number;
  spanEnd?: number;
}

export type ExtractResult =
  | { url: string; cached: boolean }
  | { warming: true };

export async function runExtraction(args: ExtractArgs): Promise<ExtractResult> {
  if (!samConfigured()) throw new Error("SAM_AUDIO_URL not configured on this deployment");
  const text = args.text.trim();
  if (!text) throw new Error("description text required");

  const spans: [number, number][] =
    args.spanStart != null && args.spanEnd != null && args.spanEnd > args.spanStart
      ? [[args.spanStart, args.spanEnd]]
      : [];

  const src = args.uploadId || args.previewUrl || "";
  if (!src) throw new Error("previewUrl or uploadId required");
  const key = createHash("sha1")
    .update(`${src}|${text}|${JSON.stringify(spans)}`)
    .digest("hex");

  const hit = await getExtraction(key).catch(() => null);
  if (hit) return { url: signedOrProxyUrl(hit.audioPath), cached: true };

  // Cold model → 202-style warming: kick the load and let the client poll.
  const warm = await samWarm(true).catch(() => false);
  if (!warm) return { warming: true };

  let srcLabel = args.previewUrl || "";
  let audioUrl: string | undefined;
  let audioB64: string | undefined;
  if (args.uploadId) {
    const rec = await getUpload(args.uploadId);
    if (!rec) throw new Error("upload not found");
    srcLabel = rec.title;
    const buf = await readAudio(rec.audioPath);
    audioB64 = buf.toString("base64");
  } else {
    audioUrl = args.previewUrl;
  }

  const sep = await samSeparate({ audioUrl, audioB64, text, spans });
  const audioPath = `extractions/${key}.wav`;
  await uploadAudio(audioPath, sep.target, "audio/wav");
  await saveExtraction(key, { text, srcLabel, audioPath, createdAt: Date.now() });
  return { url: signedOrProxyUrl(audioPath), cached: false };
}
