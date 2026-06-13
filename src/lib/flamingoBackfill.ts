// Client-side Flamingo backfill driver. A cold GPU's start (image pull + model
// load + inference) can exceed a single Cloud Run request (5min limit), so one
// backfill call may time out — but it WARMS the GPU. So we retry: the first
// attempt(s) warm it, a follow-up lands the read fast. Each attempt is awaited
// fully before the next (no concurrent GPU hits).

export interface BackfillResult {
  flamingo?: string;
  breakdown?: string;
  flamingoStatus?: string;
}

export async function pollFlamingoBackfill(
  id: string,
  apply: (bf: BackfillResult) => void,
  attempts = 8
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`/api/uploads/${id}/flamingo`, { method: "POST" });
      const bf: BackfillResult = await r.json();
      if (bf && bf.flamingo) {
        apply(bf);
        return;
      }
    } catch {
      /* keep retrying — the failed attempt still nudged the warm-up */
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
}
