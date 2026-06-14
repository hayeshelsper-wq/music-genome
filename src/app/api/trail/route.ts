// Audible Influence Trails — compare two connected artists' measured sonic DNA
// and narrate the inheritance, grounded entirely in the numbers.

import { NextRequest, NextResponse } from "next/server";
import { computeArtistSonic, cosine, sonicDeltas } from "@/lib/trail";
import { complete, bestSynthesisLlm } from "@/lib/llm";
import { ArtistSonic } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// First run analyzes top tracks for both artists (cached after) — give it room.
export const maxDuration = 300;

const SYSTEM = `You are a music critic with a trained ear, describing the SONIC INHERITANCE between two artists whose audio has actually been measured.

You're given each artist's measured DNA (averaged over their top tracks): tempo, spectral brightness in Hz, texture, rhythmic density, dynamics, energy shape, key — plus a CLAP audio-embedding similarity score (0–1) between their catalogs.

Write 2–3 tight sentences on what the later artist carried over from the earlier one and what it changed, citing the measured deltas (e.g. "kept the sub-100 BPM drag but brightened the mix by ~900 Hz"). Ground every claim in the supplied numbers. Do NOT invent instruments, songs, or biography. No preamble, no hedging.`;

function facts(label: string, a: ArtistSonic): string {
  return [
    `${label} — ${a.name}:`,
    `  tempo ${a.tempo_bpm ?? "?"} BPM, brightness ${a.brightness ?? "?"} (${a.brightness_hz ?? "?"} Hz),`,
    `  texture ${a.texture ?? "?"}, density ${a.density ?? "?"}, dynamics ${a.dynamics ?? "?"}, energy ${a.energy_shape ?? "?"}, key ${a.key ?? "?"}`,
  ].join("\n");
}

function publicView(a: ArtistSonic) {
  return {
    mbid: a.mbid,
    name: a.name,
    tempo_bpm: a.tempo_bpm,
    brightness: a.brightness,
    brightness_hz: a.brightness_hz,
    texture: a.texture,
    density: a.density,
    dynamics: a.dynamics,
    energy_shape: a.energy_shape,
    key: a.key,
    trackCount: a.trackCount,
    tracks: a.tracks,
  };
}

export async function POST(req: NextRequest) {
  let body: {
    a?: { mbid: string; name: string };
    b?: { mbid: string; name: string };
    influencer?: "a" | "b"; // which one influenced the other
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.a?.mbid || !body.a?.name || !body.b?.mbid || !body.b?.name) {
    return NextResponse.json({ error: "a and b (mbid + name) are required" }, { status: 400 });
  }

  try {
    const [a, b] = await Promise.all([
      computeArtistSonic(body.a.mbid, body.a.name),
      computeArtistSonic(body.b.mbid, body.b.name),
    ]);

    const similarity = cosine(a.embedding, b.embedding);

    // Orient earlier→later for the deltas + narration.
    const influencer = body.influencer === "b" ? b : a;
    const influenced = body.influencer === "b" ? a : b;
    const deltas = sonicDeltas(influencer, influenced);

    let narration = "";
    try {
      const user = [
        facts("EARLIER (influence)", influencer),
        facts("LATER (influenced)", influenced),
        `CLAP catalog similarity: ${similarity.toFixed(2)} (0 = unrelated, 1 = identical).`,
        `${influencer.name} influenced ${influenced.name}.`,
      ].join("\n");
      narration = await complete(SYSTEM, user, bestSynthesisLlm());
    } catch {
      narration = ""; // narration is a bonus; the measured comparison still stands
    }

    return NextResponse.json({
      a: publicView(a),
      b: publicView(b),
      influencer: influencer.mbid === a.mbid ? "a" : "b",
      similarity,
      deltas,
      narration,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "trail failed" },
      { status: 502 }
    );
  }
}
