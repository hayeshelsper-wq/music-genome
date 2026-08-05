// Asserts the request bodies generate() sends per engine, against a tiny local
// echo server. Run: npx tsx scripts/dev-test-generation.ts
import http from "http";
import assert from "assert";

const captured: { path: string; body: Record<string, unknown> }[] = [];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    captured.push({ path: req.url || "", body: JSON.parse(raw || "{}") });
    res.writeHead(200, { "Content-Type": "audio/wav", "X-Sample-Rate": "32000" });
    res.end(Buffer.from("RIFFfake"));
  });
});

async function main() {
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const base = `http://127.0.0.1:${addr.port}`;
  process.env.MUSICGEN_URL = base;
  process.env.ACESTEP_URL = base;

  // Import AFTER env is set — both modules read their URLs at module scope.
  const { generate } = await import("../src/lib/generation");

  await generate("musicgen", { prompt: "warm dub techno", durationSec: 8, seed: 42 });
  await generate("musicgen-melody", {
    prompt: "acoustic ballad",
    durationSec: 12,
    seed: 7,
    melodyWavB64: "AAAA",
  });
  await generate("acestep", {
    prompt: "synthwave anthem",
    durationSec: 60,
    lyrics: "neon nights",
    loraGcs: "gs://bucket/loras/x/adapter_model.safetensors",
    seed: 1,
  });

  assert.strictEqual(captured.length, 3, "three requests");
  assert.deepStrictEqual(captured[0].body, {
    prompt: "warm dub techno",
    duration_sec: 8,
    seed: 42,
  });
  assert.deepStrictEqual(captured[1].body, {
    prompt: "acoustic ballad",
    duration_sec: 12,
    seed: 7,
    melody_wav_b64: "AAAA",
  });
  assert.deepStrictEqual(captured[2].body, {
    prompt: "synthwave anthem",
    lyrics: "neon nights",
    duration_sec: 60,
    lora_gcs: "gs://bucket/loras/x/adapter_model.safetensors",
    seed: 1,
  });
  for (const c of captured) assert.strictEqual(c.path, "/generate");
  console.log("✅ generation.ts request bodies OK");
  server.close();
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
