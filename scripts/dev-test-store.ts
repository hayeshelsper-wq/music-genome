// Round-trips a StudioRun through Firestore — but only when the emulator is
// configured (FIRESTORE_EMULATOR_HOST); otherwise prints SKIPPED so CI/dev
// machines without the emulator don't fail.
// Run: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx tsx scripts/dev-test-store.ts
import assert from "assert";

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.log("SKIPPED — set FIRESTORE_EMULATOR_HOST to run the store round-trip");
    return;
  }
  process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "demo-test";
  const {
    createStudioRun,
    appendStudioAttempt,
    finishStudioRun,
    getStudioRun,
    listStudioRuns,
  } = await import("../src/lib/store");

  const id = `test-${Date.now()}`;
  await createStudioRun({
    id,
    createdAt: Date.now(),
    engine: "musicgen",
    source: { kind: "artist", mbid: "x" },
    referenceLabel: "Test Track",
    attempts: [],
    status: "running",
    bestAttempt: 0,
  });
  await appendStudioAttempt(id, {
    i: 0,
    prompt: "p0",
    promptSource: "claude",
    scorecard: { overall: 50, dims: [], clap: null },
    dnaMatch: 50,
    audioPath: `studio-runs/${id}/attempt-0.wav`,
  });
  await appendStudioAttempt(id, {
    i: 1,
    prompt: "p1",
    promptSource: "critic",
    scorecard: { overall: 72, dims: [], clap: 0.4 },
    dnaMatch: 72,
    audioPath: `studio-runs/${id}/attempt-1.wav`,
    critique: "brighter cymbals",
  });
  await finishStudioRun(id, { status: "done", bestAttempt: 1, stopReason: "max_iters" });

  const run = await getStudioRun(id);
  assert(run, "run readable");
  assert.strictEqual(run.attempts.length, 2);
  assert.strictEqual(run.attempts[1].dnaMatch, 72);
  assert.strictEqual(run.status, "done");
  assert.strictEqual(run.bestAttempt, 1);
  const list = await listStudioRuns(5);
  assert(list.some((r) => r.id === id), "run listed");
  console.log("✅ StudioRun round-trip OK");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
