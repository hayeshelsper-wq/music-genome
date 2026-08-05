// Proxy of the private mrt-service /health (also kicks its JAX warm-up).

import { NextResponse } from "next/server";
import { cloudRunAuthHeader } from "@/lib/cloudRun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const base = process.env.MRT_URL;
  if (!base) return NextResponse.json({ ok: false, error: "MRT_URL not configured" });
  try {
    const auth = await cloudRunAuthHeader(base);
    const res = await fetch(`${base}/health`, {
      headers: auth,
      signal: AbortSignal.timeout(45_000), // first call absorbs the JAX compile
    });
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : "health check failed",
    });
  }
}
