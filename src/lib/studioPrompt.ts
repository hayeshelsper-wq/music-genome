// Genome Studio — compose the MusicGen generation prompt.
//
// The old path (buildPrompt) only had librosa's feature vector to work with, so
// it could never know a song was *fingerpicked*, *intimate*, guitar+vocal, or
// that it closes on a solo cello — none of that lives in tempo/key/brightness.
// Music Flamingo (the audio-LLM) DOES hear those things. So when a Flamingo read
// is available, we let Claude turn it — plus the discriminative tags and the DSP
// cross-check — into a tight, concrete prompt that captures the recording's
// actual sonic identity. Falls back to the pure-DSP template if Flamingo/Claude
// aren't available.

import { complete, bestSynthesisLlm } from "@/lib/llm";
import { buildPrompt, Reference } from "@/lib/genomePrompt";
import { tagFacts, TrackFeatures } from "@/lib/trackReview";

const SYSTEM = `You write TEXT PROMPTS for MusicGen, a text-to-music model, to RE-CREATE the
spirit of a specific recording. You are given a detailed analysis of the track. Output ONE
vivid, concrete prompt that makes MusicGen reproduce the recording's sonic identity — not a
generic description.

What makes a good MusicGen prompt here:
- ONE flowing sentence or two, ~40-65 words. MusicGen dilutes long prompts — be dense, not
  long. Every word should narrow the sound.
- Name the SPECIFIC instruments AND how they are played: e.g. "fingerpicked steel-string
  acoustic guitar", "bowed solo cello", "brushed drums", "warm upright bass", "felt piano".
  Generic words like "guitar" or "instrumental" waste the prompt.
- Capture the ARRANGEMENT and FEEL: how sparse or dense, intimate vs. grand, the emotional
  tone, the sense of space/production (close-mic and dry, roomy and reverbed, lo-fi, etc.),
  and any structural turn (e.g. "closing on a mournful solo cello outro").
- Tempo: describe the FEEL ("slow", "gentle", "unhurried", "driving"). You MAY include a BPM
  only if it matches that feel. NOTE: the measured BPM is often an OCTAVE OFF (double/half
  time) — if the measured tempo contradicts a slow, sparse, intimate description, it is a
  measurement artifact; trust the feel and HALVE it (e.g. measured 129 on a slow ballad → ~65).
- Key: include it (e.g. "in G# minor").
- MusicGen is INSTRUMENTAL — it cannot sing words. Do NOT ask for vocals, lyrics, or singing.
  If a lead vocal is central to the original, render its role as an instrumental lead melody
  (e.g. "a tender lead melody carrying the topline").

Trust the sources like a working musician:
- AI LISTENER (Music Flamingo) is your PRIMARY source for what it actually sounds like —
  lean on its specifics about instruments, playing style, voice, production, harmony.
- DETECTED (tagger) is most reliable for WHICH instruments are present and whether there are
  vocals.
- MEASURED (librosa) — trust energy/structure; treat tempo as octave-suspect and key as a
  rough estimate (defer to Flamingo on key when they disagree).

Output ONLY the prompt text. No preamble, no quotes, no markdown, no "Prompt:" label.`;

function dspFacts(f: TrackFeatures): string {
  return [
    "MEASURED (librosa DSP — trust energy/structure; tempo may be octave-off, key is a rough estimate):",
    `- Tempo: ${f.tempo_bpm} BPM (${f.tempo_feel})`,
    `- Key: ${f.key} (confidence ${f.key_confidence})`,
    f.harmonic_emphasis?.length ? `- Harmonic emphasis: ${f.harmonic_emphasis.join(", ")}` : "",
    `- Texture: ${f.texture}; Brightness: ${f.brightness}; Density: ${f.density}; Dynamics: ${f.dynamics}`,
    `- Energy arc: ${f.energy_shape}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export type PromptSource = "claude+flamingo" | "claude" | "template";

/** Compose the MusicGen prompt for a reference, preferring a Flamingo-grounded
 *  Claude write-up and falling back to the pure-DSP template. */
export async function composeStudioPrompt(
  ref: Reference
): Promise<{ prompt: string; model: string; source: PromptSource }> {
  const template = buildPrompt(ref);

  // The discriminative tagger is the reliable word on whether a vocal is present;
  // the AF-Next captioner sometimes insists a vocal track is "solo instrumental".
  // When the tagger says vocals are present, override that — and since MusicGen
  // can't sing, render the vocal as a lead melody line (never tag it instrumental).
  const vocalPresent = !!ref.tags?.voice?.vocal;
  const facts = [
    `Track to re-create: ${ref.label}${ref.artist ? ` — ${ref.artist}` : ""}`,
    "",
    vocalPresent
      ? "VOCAL PRESENCE (authoritative): a reliable vocal detector confirms a LEAD VOCAL is present in this track. Treat it as a vocal song even if the AI listener below calls it instrumental or says there are no vocals — the detector is right about presence. MusicGen cannot sing, so render the vocal as a prominent lead melody line carrying the topline; do NOT describe the track as 'instrumental'."
      : "",
    "",
    ref.flamingo
      ? `AI LISTENER — Music Flamingo's detailed read of the recording (PRIMARY source for HOW things are played, but NOT authoritative on vocal presence — see above):\n${String(ref.flamingo).slice(0, 5000)}`
      : "",
    "",
    tagFacts(ref.tags),
    "",
    dspFacts(ref.features),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const llm = bestSynthesisLlm();
    let prompt = (await complete(SYSTEM, facts, llm)).trim();
    // strip any stray wrapping quotes / "Prompt:" label / surrounding whitespace
    prompt = prompt
      .replace(/^\s*(prompt|generation prompt)\s*[:\-]\s*/i, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!prompt) return { prompt: template, model: "", source: "template" };
    return { prompt, model: llm.model ?? "", source: ref.flamingo ? "claude+flamingo" : "claude" };
  } catch {
    return { prompt: template, model: "", source: "template" };
  }
}
