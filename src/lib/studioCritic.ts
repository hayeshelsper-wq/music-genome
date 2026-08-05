// The optimizer loop's critic: reads the scorecard for the latest generated
// clip against the reference DNA and revises the generation prompt with the
// smallest change likely to close the worst gaps. Pure prompt-engineering —
// all measurement happens elsewhere (scoreDna on real analysis output).

import { complete, bestSynthesisLlm } from "./llm";
import { Reference, Scorecard } from "./genomePrompt";
import { dspFacts } from "./studioPrompt";
import { tagFacts } from "./trackReview";

export interface CritiqueResult {
  analysis: string;
  changes: string[];
  prompt: string;
}

const SYSTEM = `You revise TEXT PROMPTS for a text-to-music model to close measured gaps between a generated
clip and a reference recording. You receive the reference's measured DNA, the current prompt,
a scorecard (per-dimension target vs achieved vs score), and all prior attempts with scores.

Craft rules:
- Change the FEWEST words that plausibly move the failing dimensions; after attempt 0 never
  rewrite wholesale — preserve what already scores well.
- Tempo miss: state the BPM explicitly and use feel words consistent with it. Measured tempo
  is often octave-off; if achieved ≈ 2x or 0.5x target, treat tempo as MATCHED and say so.
- Key miss: name the key early in the prompt. Keys are weakly steerable — after two failed
  key corrections, stop spending words on key.
- Brightness too dark → add timbre words (shimmering, airy, crisp cymbals, presence);
  too bright → (warm, mellow, rounded, tape-saturated, subdued highs).
- Low CLAP similarity with decent scalars means the IDENTITY is off: revisit instrument
  choices and production-space words; consider whether the prompt implies the wrong subgenre.
- Priority when dimensions conflict: CLAP similarity > tempo > brightness > key.
- Do not repeat a prompt that already appears in the attempt history.

Output ONLY minified JSON: {"analysis":"...","changes":["..."],"prompt":"..."}
No markdown, no code fences.`;

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function parseCritique(raw: string): CritiqueResult {
  const j = JSON.parse(stripFences(raw)) as Partial<CritiqueResult>;
  if (typeof j.prompt !== "string" || !j.prompt.trim()) {
    throw new Error("critic output missing prompt");
  }
  return {
    analysis: typeof j.analysis === "string" ? j.analysis : "",
    changes: Array.isArray(j.changes) ? j.changes.map(String) : [],
    prompt: j.prompt.trim(),
  };
}

export async function critiqueAndRevise(args: {
  reference: Reference;
  currentPrompt: string;
  scorecard: Scorecard;
  history: { prompt: string; dnaMatch: number; worstDims: string[] }[];
  engine: string;
}): Promise<CritiqueResult> {
  const { reference, currentPrompt, scorecard, history, engine } = args;

  const scorecardRows = scorecard.dims
    .map(
      (d) =>
        `- ${d.label}: target=${d.target} achieved=${d.achieved} score=${d.score}` +
        (d.detail ? ` (${d.detail})` : "")
    )
    .join("\n");

  const historyBlock = history.length
    ? history
        .map(
          (h, i) =>
            `attempt ${i}: dnaMatch=${h.dnaMatch} worst=[${h.worstDims.join(", ")}]\n  prompt: ${h.prompt}`
        )
        .join("\n")
    : "(none)";

  const user = [
    `Engine: ${engine}`,
    `Reference: ${reference.label}${reference.artist ? ` — ${reference.artist}` : ""}`,
    "",
    dspFacts(reference.features),
    "",
    tagFacts(reference.tags),
    "",
    `CURRENT PROMPT:\n${currentPrompt}`,
    "",
    `SCORECARD (overall DNA match ${scorecard.overall}/100):\n${scorecardRows}`,
    "",
    `ATTEMPT HISTORY:\n${historyBlock}`,
  ]
    .filter(Boolean)
    .join("\n");

  const llm = bestSynthesisLlm();
  const first = await complete(SYSTEM, user, llm);
  try {
    return parseCritique(first);
  } catch {
    const retry = await complete(
      SYSTEM,
      `${user}\n\nYour last output was not valid JSON.`,
      llm
    );
    return parseCritique(retry); // throws on second failure — route handles it
  }
}
