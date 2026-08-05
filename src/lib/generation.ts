// Engine-agnostic generation front door. Every text-to-music backend the app
// can talk to sits behind one generate() call so routes (Studio one-shot,
// optimizer loop, hum production) never care which GPU service is on the other
// end. musicgen delegates to the existing client in musicgen.ts; the other
// engines follow the same auth/timeout pattern against their own services.

import { cloudRunAuthHeader } from "./cloudRun";
import { generateMusic } from "./musicgen";

export type Engine = "musicgen" | "musicgen-melody" | "acestep";

export interface GenerateOpts {
  prompt: string;
  durationSec?: number;
  lyrics?: string | null; // acestep only
  loraGcs?: string | null; // acestep only
  melodyWavB64?: string | null; // musicgen-melody only
  seed?: number | null;
  timeoutMs?: number;
}

const MUSICGEN_URL = process.env.MUSICGEN_URL || "http://127.0.0.1:8090";

function acestepUrl(): string {
  const url = process.env.ACESTEP_URL;
  if (!url) throw new Error("ACESTEP_URL not configured");
  return url;
}

async function postForWav(
  base: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const auth = await cloudRunAuthHeader(base);
    const res = await fetch(`${base}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`generate ${res.status} ${text.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export async function generate(engine: Engine, opts: GenerateOpts): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  switch (engine) {
    case "musicgen":
      return generateMusic(opts.prompt, opts.durationSec ?? 10, timeoutMs, opts.seed ?? null);
    case "musicgen-melody":
      return postForWav(
        MUSICGEN_URL,
        {
          prompt: opts.prompt,
          duration_sec: opts.durationSec ?? 10,
          ...(opts.seed != null ? { seed: opts.seed } : {}),
          ...(opts.melodyWavB64 ? { melody_wav_b64: opts.melodyWavB64 } : {}),
        },
        timeoutMs
      );
    case "acestep":
      return postForWav(
        acestepUrl(),
        {
          prompt: opts.prompt,
          lyrics: opts.lyrics ?? null,
          duration_sec: opts.durationSec ?? 60,
          lora_gcs: opts.loraGcs ?? null,
          ...(opts.seed != null ? { seed: opts.seed } : {}),
        },
        timeoutMs
      );
    default: {
      const never: never = engine;
      throw new Error(`unknown engine ${String(never)}`);
    }
  }
}
