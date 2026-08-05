// Unit-covers the MediaRecorder container fallback chain (mobile Safari path).
// Run: npx tsx scripts/dev-test-mime.ts
import assert from "assert";
import { pickRecorderMime, extForMime } from "../src/lib/recorderMime";

// Chrome/Firefox: webm+opus supported.
assert.strictEqual(
  pickRecorderMime((t) => t.startsWith("audio/webm")),
  "audio/webm;codecs=opus"
);
// Mobile Safari: only mp4.
assert.strictEqual(pickRecorderMime((t) => t === "audio/mp4"), "audio/mp4");
// Nothing supported.
assert.strictEqual(pickRecorderMime(() => false), null);
// Browsers that throw on unknown types still fall through.
assert.strictEqual(
  pickRecorderMime((t) => {
    if (t !== "audio/mp4") throw new Error("unknown type");
    return true;
  }),
  "audio/mp4"
);
assert.strictEqual(extForMime("audio/mp4"), "m4a");
assert.strictEqual(extForMime("audio/webm;codecs=opus"), "webm");
assert.strictEqual(extForMime(null), "webm");
console.log("✅ recorder mime chain OK");
