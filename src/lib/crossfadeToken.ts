// Mint short-lived crossfader session tokens: `${expMs}.${b64url(HMAC-SHA256(expMs))}`
// shared-secret with the audio-service WS proxy (CROSSFADE_TOKEN_SECRET).

import { createHmac } from "crypto";

const TTL_MS = 10 * 60 * 1000;

export function mintCrossfadeToken(secret: string, now = Date.now()): string {
  const exp = String(now + TTL_MS);
  const sig = createHmac("sha256", secret).update(exp).digest("base64url");
  return `${exp}.${sig}`;
}

export function crossfadeConfigured(): boolean {
  return !!process.env.CROSSFADE_TOKEN_SECRET;
}
