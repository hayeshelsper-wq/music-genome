// "Ask the Genome" — an agentic music-research endpoint.
//
// Claude drives the app's own capabilities (the knowledge graph, the iTunes
// catalog, CLAP audio search, per-track DSP/Flamingo analyses, Genius credits)
// as a tool surface, planning multi-step queries no search box could answer.
// We run the agent loop manually so we can stream the trajectory to the UI:
// every token, every tool call, and every tool result is emitted as NDJSON so
// the client can render the agent thinking and acting in the open.

import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, runTool } from "@/lib/genomeTools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A single turn can ingest a never-seen artist (MusicBrainz 1 req/s ≈ 70s) and
// chain several tool calls, so give the loop generous headroom. (Self-hosted on
// Cloud Run the real ceiling is the service --timeout=600 in deploy/deploy.sh;
// this is advisory but kept in sync.)
export const maxDuration = 600;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const MAX_STEPS = 8; // tool-call rounds before we force a final answer

const SYSTEM = `You are "Ask the Genome", a music-intelligence research agent inside The Music Genome Project.

You answer questions about artists, songs, sound, lineage, collaboration, and production by USING TOOLS — never from memory alone. Plan multi-step: resolve names to ids, look things up, then combine the results.

Ground rules:
- To use get_artist_dna you need an mbid: call search_artist first and pick the best match.
- Ground every factual claim in a tool result. If the tools don't support a claim, say so plainly rather than inventing collaborators, influences, producers, or genres.
- For cross-modal asks (e.g. "sounds like X but shares a producer with Y"), use the audio tools (search_by_sound / find_sonic_twins / get_track_details) for the SOUND part and the graph/credits tools for the relationship part, then intersect them yourself.
- The audio/library tools only see the user's uploaded tracks. If the library is empty or a track isn't analyzed, say so and pivot to the catalog (get_artist_top_tracks) and graph tools.

Style:
- Sharp, specific, opinionated — a knowledgeable music friend, not an encyclopedia. No filler preamble.
- When you reference an artist, link them as a markdown link to their DNA report: [Name](/artist/THAT_ENTITY_MBID), using ONLY that specific entity's own mbid from a tool result. Never reuse one artist's mbid for another, and if an entity has no mbid in the results, just bold the name instead of linking it.
- Use concise markdown: short paragraphs, bold for names when not linking, and bullet lists for sets of results. Keep answers tight.`;

interface ClientMsg {
  role: "user" | "assistant";
  text: string;
}

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      {
        error:
          "Ask the Genome needs ANTHROPIC_API_KEY set (Claude drives the tool use). Add it to .env.local.",
      },
      { status: 400 }
    );
  }

  let body: { question?: string; history?: ClientMsg[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const question = (body.question || "").trim();
  if (!question)
    return Response.json({ error: "question is required" }, { status: 400 });

  const client = new Anthropic();

  // Prior turns are sent as plain text; rebuild the message list and append the
  // new question. Tool-use/result blocks from past turns are not replayed — each
  // question re-plans from the visible conversation, which keeps state simple.
  const messages: Anthropic.MessageParam[] = [];
  for (const m of body.history || []) {
    if (m && (m.role === "user" || m.role === "assistant") && m.text)
      messages.push({ role: m.role, content: m.text });
  }
  messages.push({ role: "user", content: question });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          const turn = client.messages.stream({
            model: MODEL,
            max_tokens: 4096,
            thinking: { type: "adaptive" },
            system: SYSTEM,
            tools: TOOLS as unknown as Anthropic.Tool[],
            messages,
          });

          turn.on("text", (delta) => send({ t: "token", v: delta }));

          const msg = await turn.finalMessage();
          // Preserve the full content (incl. thinking + tool_use blocks) so the
          // next turn is valid after we append tool results.
          messages.push({ role: "assistant", content: msg.content });

          const toolUses = msg.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
          );
          if (msg.stop_reason !== "tool_use" || toolUses.length === 0) break;

          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            send({ t: "tool", name: tu.name, input: tu.input });
            const { ok, content } = await runTool(
              tu.name,
              (tu.input as Record<string, unknown>) || {}
            );
            send({ t: "tool_done", name: tu.name, ok });
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content,
              is_error: !ok,
            });
          }
          messages.push({ role: "user", content: results });

          if (step === MAX_STEPS - 1)
            send({
              t: "token",
              v: "\n\n_(stopped after reaching the tool-step limit.)_",
            });
        }
        send({ t: "done" });
      } catch (e) {
        send({ t: "error", v: e instanceof Error ? e.message : "agent failed" });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
