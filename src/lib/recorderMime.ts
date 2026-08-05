// MediaRecorder container negotiation, extracted so the fallback chain is unit
// testable in Node (mobile Safari has no webm — it must land on audio/mp4).

export const RECORDER_MIME_CHAIN = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
] as const;

export function pickRecorderMime(
  isTypeSupported: (type: string) => boolean
): string | null {
  for (const t of RECORDER_MIME_CHAIN) {
    try {
      if (isTypeSupported(t)) return t;
    } catch {
      // some browsers throw on unknown types — treat as unsupported
    }
  }
  return null;
}

export function extForMime(mime: string | null): string {
  if (!mime) return "webm";
  if (mime.includes("mp4")) return "m4a";
  return "webm";
}
