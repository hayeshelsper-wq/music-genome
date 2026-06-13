// Tiny shared-password gate. A login sets a signed httpOnly cookie; middleware
// verifies it on every request. Uses Web Crypto (HMAC-SHA256) so the same code
// runs in both the Edge middleware and Node route handlers. The cookie is an
// expiry + HMAC of that expiry, so it can't be forged without AUTH_SECRET.

export const AUTH_COOKIE = "mg_auth";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(msg: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return b64url(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function makeToken(secret: string): Promise<string> {
  const exp = String(Date.now() + TTL_MS);
  return `${exp}.${await hmac(exp, secret)}`;
}

export async function verifyToken(
  token: string | undefined,
  secret: string
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return timingSafeEqual(sig, await hmac(exp, secret));
}

/** Auth is enforced only when both vars are present (so local dev stays open). */
export function authConfigured(): boolean {
  return !!(process.env.AUTH_PASSWORD && process.env.AUTH_SECRET);
}
