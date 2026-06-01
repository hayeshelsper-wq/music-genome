import { NextRequest, NextResponse } from "next/server";
import { getSongMeta, getLyrics } from "@/lib/genius";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const AUDIO = process.env.AUDIO_SERVICE_URL || "http://127.0.0.1:8000";

interface Karaoke { start: number; end: number; text: string; source: string }
interface StemResult {
  stems: Record<string, string>;
  melody: { contour: (number | null)[]; topNotes: string[]; voicedFraction: number };
  groove: { tempo: number; hitsPerSec: number; onsets: number[] };
  karaoke: Karaoke[];
}

const g = globalThis as unknown as { __stemCache?: Map<string, StemResult> };
const cache: Map<string, StemResult> = g.__stemCache ?? (g.__stemCache = new Map());

const tokens = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
function sim(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let i = 0;
  A.forEach((t) => B.has(t) && i++);
  return i / Math.max(A.size, B.size);
}

export async function GET(req: NextRequest) {
  const previewUrl = req.nextUrl.searchParams.get("previewUrl");
  const title = req.nextUrl.searchParams.get("title") || "";
  const artist = req.nextUrl.searchParams.get("artist") || "";
  if (!previewUrl) return NextResponse.json({ error: "previewUrl required" }, { status: 400 });
  if (cache.has(previewUrl)) return NextResponse.json(cache.get(previewUrl));

  try {
    const res = await fetch(`${AUDIO}/stems`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previewUrl }),
    });
    const data = (await res.json()) as {
      stems?: Record<string, string>;
      melody?: StemResult["melody"];
      groove?: StemResult["groove"];
      karaoke?: { start: number; end: number; text: string }[];
      error?: string;
    };
    if (data.error || !data.stems) {
      return NextResponse.json({ error: data.error || "no stems" }, { status: 502 });
    }

    // make stem file URLs absolute (browser loads them straight from the service)
    const stems: Record<string, string> = {};
    for (const [k, v] of Object.entries(data.stems)) stems[k] = `${AUDIO}${v}`;

    // karaoke: keep Whisper's *timing*, but show the accurate Genius line per segment
    const meta = await getSongMeta(artist, title).catch(() => null);
    const lyrics = meta?.url ? await getLyrics(meta.url).catch(() => null) : null;
    const lines = (lyrics || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^\[.*\]$/.test(l));

    // Whisper on the vocal stem gives accurate *timing* but garbled text, and it
    // merges several lyric lines into one segment. So: anchor with strong fuzzy
    // matches (monotonic), then fill the accurate Genius lines in order between
    // anchors. Text is always Genius (correct); only the timing is approximate.
    const segs = data.karaoke || [];
    let lastIdx = -1;
    const karaoke: Karaoke[] = segs.map((seg) => {
      let best = { score: 0, idx: -1 };
      lines.forEach((ln, idx) => {
        const s = sim(seg.text, ln);
        if (s > best.score) best = { score: s, idx };
      });
      let idx: number;
      if (best.score >= 0.3 && best.idx > lastIdx) idx = best.idx; // confident anchor
      else idx = lastIdx + 1; // otherwise next accurate line in sequence
      lastIdx = idx;
      const line = lines[idx];
      return {
        start: seg.start,
        end: seg.end,
        text: line || seg.text,
        source: line ? "genius" : "whisper",
      };
    });

    const result: StemResult = {
      stems,
      melody: data.melody!,
      groove: data.groove!,
      karaoke,
    };
    cache.set(previewUrl, result);
    return NextResponse.json(result);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "stem separation failed" },
      { status: 502 }
    );
  }
}
