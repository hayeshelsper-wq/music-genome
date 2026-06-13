// Service-to-service auth for private Cloud Run services. On Cloud Run, fetch a
// Google-signed ID token from the metadata server (audience = the target service
// URL) so the web app can call the authenticated audio-service. Locally there's
// no metadata server, so this no-ops and the call goes out unauthenticated —
// which is exactly right for localhost.

const METADATA =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

export async function cloudRunAuthHeader(
  targetUrl: string
): Promise<Record<string, string>> {
  try {
    const u = new URL(targetUrl);
    const audience = `${u.protocol}//${u.host}`;
    const res = await fetch(
      `${METADATA}?audience=${encodeURIComponent(audience)}`,
      {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(1500),
      }
    );
    if (!res.ok) return {};
    const token = (await res.text()).trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {}; // not on GCP (local dev) → unauthenticated
  }
}
