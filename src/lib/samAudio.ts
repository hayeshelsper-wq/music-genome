// Client for the SAM Audio extraction service (private Cloud Run, IAM-gated).
// Text-prompted separation: "the tambourine", "crowd noise", "the guitar solo".

import { cloudRunAuthHeader } from "./cloudRun";

function samUrl(): string {
  const url = process.env.SAM_AUDIO_URL;
  if (!url) throw new Error("SAM_AUDIO_URL not configured");
  return url;
}

export function samConfigured(): boolean {
  return !!process.env.SAM_AUDIO_URL;
}

/** Health probe; `kickLoad` starts a cold model warming in the background. */
export async function samWarm(kickLoad = false): Promise<boolean> {
  const base = samUrl();
  const auth = await cloudRunAuthHeader(base);
  const res = await fetch(`${base}/health${kickLoad ? "?load=1" : ""}`, {
    headers: auth,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return false;
  const j = (await res.json()) as { loaded?: boolean; error?: string | null };
  return !!j.loaded && !j.error;
}

export interface SeparateResult {
  target: Buffer;
  residual?: Buffer;
  sr: number;
}

export async function samSeparate(args: {
  audioUrl?: string;
  audioB64?: string;
  text: string;
  spans?: [number, number][];
  timeoutMs?: number;
}): Promise<SeparateResult> {
  const base = samUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 240_000);
  try {
    const auth = await cloudRunAuthHeader(base);
    const res = await fetch(`${base}/separate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        ...(args.audioUrl ? { audio_url: args.audioUrl } : {}),
        ...(args.audioB64 ? { audio_b64: args.audioB64 } : {}),
        text: args.text,
        ...(args.spans?.length ? { spans: args.spans } : {}),
        return_residual: true,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`sam-audio ${res.status} ${t.slice(0, 200)}`);
    }
    const j = (await res.json()) as {
      error?: string;
      target_wav_b64?: string;
      residual_wav_b64?: string;
      sr?: number;
    };
    if (j.error || !j.target_wav_b64) throw new Error(j.error || "no target returned");
    return {
      target: Buffer.from(j.target_wav_b64, "base64"),
      residual: j.residual_wav_b64 ? Buffer.from(j.residual_wav_b64, "base64") : undefined,
      sr: j.sr || 48000,
    };
  } finally {
    clearTimeout(timer);
  }
}
