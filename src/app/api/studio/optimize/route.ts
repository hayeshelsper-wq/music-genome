// Genome Studio — the agentic optimizer loop, streamed as NDJSON:
// generate → analyze (real pipeline) → score vs the reference DNA → Claude
// critiques and revises the prompt → repeat, until the DNA match clears the
// threshold, plateaus, or runs out of attempts. Every attempt is persisted so
// runs are reviewable at /studio?run=<id>.

import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { analyzeClip } from "@/lib/musicgen";
import { generate, Engine } from "@/lib/generation";
import { scoreDna, Scorecard } from "@/lib/genomePrompt";
import { composeStudioPromptForEngine } from "@/lib/studioPrompt";
import { buildReference, centerCutWav } from "@/lib/studioRun";
import { critiqueAndRevise } from "@/lib/studioCritic";
import {
  createStudioRun,
  appendStudioAttempt,
  finishStudioRun,
  StudioAttempt,
} from "@/lib/store";
import { uploadAudio, signedOrProxyUrl } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const MAX_ITERS = Math.max(1, Number(process.env.STUDIO_MAX_ITERS || 4));
const DNA_THRESHOLD = Number(process.env.STUDIO_DNA_THRESHOLD || 80);

function worstDims(sc: Scorecard): string[] {
  return sc.dims
    .slice()
    .sort((a, b) => a.score - b.score)
    .slice(0, 2)
    .map((d) => d.label);
}

export async function POST(req: NextRequest) {
  let body: {
    source?: { kind: string; id?: string; mbid?: string };
    engine?: "musicgen" | "acestep";
    durationSec?: number;
    lyrics?: string;
    loraGcs?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const source = body.source;
  if (!source?.kind) return Response.json({ error: "source required" }, { status: 400 });
  const engine: Engine = body.engine === "acestep" ? "acestep" : "musicgen";
  const durationSec =
    engine === "acestep"
      ? Math.max(10, Math.min(120, body.durationSec || 60))
      : Math.max(4, Math.min(15, body.durationSec || 10));
  const lyrics = body.lyrics || null;
  const loraGcs = body.loraGcs || null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const emit = (obj: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          closed = true;
        }
      };

      const runId = randomUUID();
      let runCreated = false;
      try {
        const reference = await buildReference(source);
        const composed = await composeStudioPromptForEngine(reference, engine, lyrics);
        let prompt = composed.prompt;
        let promptSource: string = composed.source;
        const effectiveLyrics = composed.lyrics;

        await createStudioRun({
          id: runId,
          createdAt: Date.now(),
          engine,
          source,
          referenceLabel: reference.artist
            ? `${reference.label} — ${reference.artist}`
            : reference.label,
          attempts: [],
          status: "running",
          bestAttempt: 0,
        });
        runCreated = true;
        emit({ t: "run", runId });

        // One seed per run: attempt-to-attempt differences come from the
        // prompt changes, not sampling noise.
        const seed = Math.floor(Math.random() * 1e9);

        const history: { prompt: string; dnaMatch: number; worstDims: string[] }[] = [];
        let best = -1;
        let bestAttempt = 0;
        let sinceImprovement = 0;
        let stopReason = "max_iters";

        for (let i = 0; i < MAX_ITERS; i++) {
          emit({ t: "attempt", i, prompt, promptSource });

          const wav = await generate(engine, {
            prompt,
            durationSec,
            seed,
            lyrics: effectiveLyrics,
            loraGcs,
            timeoutMs: 300_000,
          });

          const audioPath = `studio-runs/${runId}/attempt-${i}.wav`;
          await uploadAudio(audioPath, wav, "audio/wav");
          emit({ t: "audio", i, url: signedOrProxyUrl(audioPath) });

          // Long ACE-Step clips: score the middle 30s so the analysis window
          // matches the 30s reference previews.
          const toAnalyze =
            engine === "acestep" && durationSec > 30 ? centerCutWav(wav, 30) : wav;
          const gen = await analyzeClip(toAnalyze);
          if (!gen.features) throw new Error("generated clip analysis returned no features");

          const scorecard = scoreDna(reference, {
            features: gen.features,
            embedding: gen.embedding,
          });
          const dnaMatch = scorecard.overall;
          emit({ t: "score", i, scorecard, dnaMatch });

          const attempt: StudioAttempt = {
            i,
            prompt,
            promptSource,
            scorecard,
            dnaMatch,
            audioPath,
          };
          await appendStudioAttempt(runId, attempt);
          history.push({ prompt, dnaMatch, worstDims: worstDims(scorecard) });

          if (dnaMatch > best) {
            best = dnaMatch;
            bestAttempt = i;
            sinceImprovement = 0;
          } else {
            sinceImprovement++;
          }

          if (dnaMatch >= DNA_THRESHOLD) {
            stopReason = "threshold";
            break;
          }
          if (sinceImprovement >= 2) {
            stopReason = "plateau";
            break;
          }
          if (i === MAX_ITERS - 1) break;

          let rev;
          try {
            rev = await critiqueAndRevise({
              reference,
              currentPrompt: prompt,
              scorecard,
              history,
              engine,
            });
          } catch {
            stopReason = "critic_error";
            break;
          }
          emit({ t: "critique", i, analysis: rev.analysis, changes: rev.changes });
          prompt = rev.prompt;
          promptSource = "critic";
        }

        await finishStudioRun(runId, {
          status: "done",
          bestAttempt,
          stopReason,
        });
        emit({ t: "done", bestAttempt, stopReason });
      } catch (e) {
        const message = e instanceof Error ? e.message : "optimize failed";
        emit({ t: "error", message });
        if (runCreated) {
          await finishStudioRun(runId, { status: "error", stopReason: message }).catch(
            () => {}
          );
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
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
