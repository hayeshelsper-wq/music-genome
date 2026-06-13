import { NextRequest, NextResponse } from "next/server";
import { complete, bestSynthesisLlm } from "@/lib/llm";

export const runtime = "nodejs";

interface Body {
  name?: string;
  description?: string;
  tracks?: { title: string; artist: string; album?: string }[];
}

const SYSTEM = `You are a music journalist writing the liner notes for a playlist — a short,
evocative editorial that treats the collection as a curated whole, the way a great
magazine feature or a thoughtful record-store clerk would. Find the through-line: the
mood, the era or lineage, the emotional arc, the thread that ties these songs together.
Name patterns you actually see in the tracklist — shared artists, a run of
remixes/remasters or alternate mixes, a genre or decade, a recurring feeling.

Rules:
- 110-170 words, flowing prose, present tense. No bullet points, no preamble, no
  track-by-track recap, no "this playlist" throat-clearing.
- Describe the set as an experience; do not give the listener advice.
- Be specific and vivid; never generic. If the tracklist is too thin to find a real
  thread, say so briefly and honestly rather than inventing one.
- Output ONLY the liner-note prose.`;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Body;
    const tracks = (body.tracks || []).slice(0, 60);
    if (!tracks.length)
      return NextResponse.json({ error: "no tracks" }, { status: 400 });

    const list = tracks
      .map(
        (t, i) =>
          `${i + 1}. ${t.title} — ${t.artist}${t.album ? ` (${t.album})` : ""}`
      )
      .join("\n");
    const user = [
      body.name ? `Playlist: ${body.name}` : "",
      body.description ? `Curator's description: ${body.description}` : "",
      "",
      "Tracklist:",
      list,
    ]
      .filter(Boolean)
      .join("\n");

    const llm = bestSynthesisLlm();
    const notes = (await complete(SYSTEM, user, llm)).trim();
    return NextResponse.json({ notes, model: llm.model });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 500 }
    );
  }
}
