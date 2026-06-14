// Lineage Walk — auto-build a path through the influence graph (forward through
// descendants, or back through influences), fingerprint each artist's sound, and
// narrate the journey like a guided audio documentary. Builds on the Trail infra.

import { NextRequest, NextResponse } from "next/server";
import { isIngested, getReport, ArtistSonic } from "@/lib/store";
import { ingestArtist } from "@/lib/ingest";
import { computeArtistSonic, cosine } from "@/lib/trail";
import { complete, bestSynthesisLlm } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const isMbid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);

const SYSTEM = `You are narrating a short audio documentary that walks through a chain of musical influence, hop by hop. You're given each artist in order with their MEASURED sonic DNA (tempo, brightness in Hz, texture, energy) and the CLAP audio-similarity between consecutive artists.

Write ONE flowing paragraph (4–6 sentences) tracing how the sound mutates along the chain — name each artist in order and cite a concrete measured shift at each hop (tempo, brightness, texture). Ground every claim in the numbers; invent nothing. No preamble.`;

function facts(a: ArtistSonic): string {
  return `${a.name}: ${a.tempo_bpm ?? "?"} BPM, ${a.brightness ?? "?"} (${a.brightness_hz ?? "?"} Hz), ${a.texture ?? "?"} texture, ${a.energy_shape ?? "?"} energy, key ${a.key ?? "?"}`;
}

export async function POST(req: NextRequest) {
  let body: { mbid?: string; name?: string; direction?: "forward" | "back"; hops?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!body.mbid || !body.name) return NextResponse.json({ error: "mbid + name required" }, { status: 400 });
  const direction = body.direction === "back" ? "back" : "forward";
  const maxHops = Math.max(1, Math.min(4, body.hops || 3));

  try {
    // 1. Walk the graph to build an ordered path of artists.
    const path: { mbid: string; name: string }[] = [{ mbid: body.mbid, name: body.name }];
    const seen = new Set([body.mbid]);
    let cur = path[0];
    const group = direction === "back" ? "influence" : "descendant";
    for (let i = 0; i < maxHops; i++) {
      if (!(await isIngested(cur.mbid))) await ingestArtist(cur.mbid);
      const report = await getReport(cur.mbid);
      if (!report) break;
      const next = report.family.nodes.find(
        (n) => n.group === group && isMbid(n.id) && !seen.has(n.id)
      );
      if (!next) break;
      seen.add(next.id);
      cur = { mbid: next.id, name: next.name };
      path.push(cur);
    }
    if (path.length < 2) {
      return NextResponse.json(
        { error: `No ${direction === "back" ? "influences" : "descendants"} with audio to walk from ${body.name}.` },
        { status: 404 }
      );
    }

    // 2. Fingerprint each artist (cached); drop any with no playable audio.
    const fps = await Promise.all(
      path.map((p) => computeArtistSonic(p.mbid, p.name).catch(() => null))
    );
    const chain = fps.filter((f): f is ArtistSonic => !!f && Array.isArray(f.embedding) && f.embedding.length > 0);
    if (chain.length < 2) {
      return NextResponse.json({ error: "Couldn't fingerprint enough artists in this lineage." }, { status: 502 });
    }

    // 3. Consecutive similarities + one narration over the whole walk.
    const links = chain.slice(1).map((b, i) => ({
      from: chain[i].name, to: b.name, similarity: cosine(chain[i].embedding, b.embedding),
    }));

    let narration = "";
    try {
      const user = [
        `Direction: ${direction === "back" ? "backward through influences" : "forward through descendants"}.`,
        "Chain (in order):",
        ...chain.map((a, i) => `${i + 1}. ${facts(a)}`),
        "Consecutive CLAP similarity: " + links.map((l) => `${l.from}→${l.to} ${l.similarity.toFixed(2)}`).join("; "),
      ].join("\n");
      narration = await complete(SYSTEM, user, bestSynthesisLlm());
    } catch { narration = ""; }

    return NextResponse.json({
      direction,
      artists: chain.map((a) => ({
        mbid: a.mbid, name: a.name,
        tempo_bpm: a.tempo_bpm, key: a.key, brightness: a.brightness, energy_shape: a.energy_shape,
        track: a.tracks[0] || null,
      })),
      links,
      narration,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "lineage failed" }, { status: 502 });
  }
}
