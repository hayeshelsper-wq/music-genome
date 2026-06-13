import { NextRequest, NextResponse } from "next/server";
import { getSongMeta, getLyricsText } from "@/lib/genius";
import { cloudRunAuthHeader } from "@/lib/cloudRun";

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

// Stopwords are dropped before matching: a single shared "I"/"the"/"you" between
// a garbled Whisper segment and a *distant* repeated line was enough to clear the
// old threshold and yank the karaoke pointer far ahead. We match on content words.
const STOP = new Set(
  ("a an the and or but so if then this that these those of in on at to for with " +
    "is are was were be been being am do does did i you he she it we they me my your " +
    "his her its our their him them us no not yes oh yeah yea na la ooh uh hey now " +
    "up down out just all got get gon gonna wanna cause cuz like").split(/\s+/)
);
const tokens = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
const contentTokens = (s: string) =>
  tokens(s).filter((t) => t.length > 1 && !STOP.has(t));
function sim(a: string, b: string): number {
  const A = new Set(contentTokens(a));
  const B = new Set(contentTokens(b));
  if (!A.size || !B.size) return 0;
  let i = 0;
  A.forEach((t) => B.has(t) && i++);
  return i / Math.max(A.size, B.size);
}

// Only anchor to a line within this many positions ahead of the last one. Whisper
// segments march forward in time roughly in step with the lyrics, so the true next
// line is always just ahead — a high-scoring match far down the page is a repeated
// chorus/refrain, not the real position, and must not be allowed to hijack sync.
const ANCHOR_WINDOW = 8;
// Require real content overlap, not one coincidental shared word.
const ANCHOR_MIN = 0.34;

export async function GET(req: NextRequest) {
  const previewUrl = req.nextUrl.searchParams.get("previewUrl");
  const title = req.nextUrl.searchParams.get("title") || "";
  const artist = req.nextUrl.searchParams.get("artist") || "";
  if (!previewUrl) return NextResponse.json({ error: "previewUrl required" }, { status: 400 });
  if (cache.has(previewUrl)) return NextResponse.json(cache.get(previewUrl));

  try {
    const auth = await cloudRunAuthHeader(AUDIO);
    const res = await fetch(`${AUDIO}/stems`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
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

    // The audio-service is private (IAM-only), so the browser can't load the stem
    // files directly. Route them through our own /api/track/stem proxy, which has
    // the IAM creds to fetch them. (Locally this proxies localhost just the same.)
    const stems: Record<string, string> = {};
    for (const [k, v] of Object.entries(data.stems))
      stems[k] = `/api/track/stem?p=${encodeURIComponent(v)}`;

    // karaoke: keep Whisper's *timing*, but show the accurate Genius line per segment
    const meta = await getSongMeta(artist, title).catch(() => null);
    const lyrics = await getLyricsText(artist, title, meta?.url).catch(
      () => null
    );
    const lines = (lyrics || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^\[.*\]$/.test(l));

    // Whisper on the vocal stem gives accurate *timing* but garbled text, and it
    // merges several lyric lines into one segment. So: anchor with strong fuzzy
    // matches (monotonic), then fill the accurate Genius lines in order between
    // anchors. Text is always Genius (correct); only the timing is approximate.
    const segs = data.karaoke || [];
    // The preview clip is usually a mid-song section (often the chorus), while
    // the lyrics start at the intro. Match the first segment against ALL lines
    // once to find where the clip actually begins; the bounded forward search
    // below then keeps later segments from leaping to distant repeated lines.
    let lastIdx = -1;
    if (segs.length && lines.length) {
      let g = { score: 0, idx: -1 };
      for (let idx = 0; idx < lines.length; idx++) {
        const s = sim(segs[0].text, lines[idx]);
        if (s > g.score) g = { score: s, idx };
      }
      if (g.score >= ANCHOR_MIN) lastIdx = g.idx - 1;
    }
    const karaoke: Karaoke[] = segs.map((seg) => {
      // Search only the near-forward window. The best match *within reach* anchors;
      // a distant repeated line is never even considered, so it can't leap the
      // pointer 16 lines ahead and then strand the rest of the song shifted.
      const from = lastIdx + 1;
      const to = Math.min(lines.length, from + ANCHOR_WINDOW);
      let best = { score: 0, idx: -1 };
      for (let idx = from; idx < to; idx++) {
        const s = sim(seg.text, lines[idx]);
        if (s > best.score) best = { score: s, idx }; // ties keep the nearest line
      }
      let idx: number;
      if (best.score >= ANCHOR_MIN) idx = best.idx; // confident, in-window anchor
      else idx = from; // no real match — just advance to the next accurate line
      idx = Math.min(idx, Math.max(lines.length - 1, 0));
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
