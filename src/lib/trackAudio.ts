import { cloudRunAuthHeader } from "@/lib/cloudRun";
import { TrackFeatures, TagSet } from "@/lib/trackReview";

// Audio-service callers shared by the X-ray route and its async Flamingo backfill.

const AUDIO_SERVICE = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

export interface AudioResult {
  features: TrackFeatures | null;
  lyrics: { text: string; lines: string[] };
  chromagram: string | null;
  tags?: TagSet | null;
  error?: string;
}

export async function callAudio(
  previewUrl: string,
  title: string,
  artist: string
): Promise<AudioResult> {
  const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
  const res = await fetch(`${AUDIO_SERVICE}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ previewUrl, title, artist }),
  });
  if (!res.ok) throw new Error(`audio-service ${res.status}`);
  return (await res.json()) as AudioResult;
}

// Flamingo is a best-effort BONUS — it must never block the X-ray. The GPU can be
// cold (model loading) or down. The X-ray's first paint sets requireWarm=true so a
// cold GPU returns instantly (cold=true) and the page degrades to the async
// /api/track/flamingo backfill; the backfill calls with a long timeout to warm it.
// Sized for a verbose (~1024-token) generation on a WARM L4 (~45-55s).
const FLAMINGO_TIMEOUT_MS = 75_000;

export async function callFlamingo(
  previewUrl: string,
  opts: { requireWarm?: boolean; timeoutMs?: number; flamingoTimeoutSec?: number } = {}
): Promise<{ text: string; error?: string; cold?: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? FLAMINGO_TIMEOUT_MS);
  try {
    const auth = await cloudRunAuthHeader(AUDIO_SERVICE);
    const res = await fetch(`${AUDIO_SERVICE}/flamingo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        previewUrl,
        requireWarm: opts.requireWarm ?? false,
        timeout: opts.flamingoTimeoutSec,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { text: "", error: `audio-service ${res.status}` };
    const json = (await res.json()) as {
      description?: string;
      error?: string;
      disabled?: boolean;
      cold?: boolean;
    };
    if (json.disabled) return { text: "", error: "disabled" };
    if (json.cold) return { text: "", cold: true };
    if (json.description) return { text: json.description };
    return { text: "", error: json.error || "no response" };
  } catch (e) {
    // best-effort — the critique still runs on librosa + Genius
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      text: "",
      error: aborted ? "flamingo timed out (GPU warming up)" : "audio service unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}
