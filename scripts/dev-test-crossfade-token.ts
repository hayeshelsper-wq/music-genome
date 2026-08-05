// Round-trips the crossfader token: TS mint → Python verify (audio-service's
// crossfade_token.py), plus tamper/expiry rejection on both sides.
// Run: npx tsx scripts/dev-test-crossfade-token.ts
import assert from "assert";
import { execFileSync } from "child_process";
import path from "path";
import { mintCrossfadeToken } from "../src/lib/crossfadeToken";

const SECRET = "test-secret-123";
const py = path.join(__dirname, "..", "audio-service", ".venv", "bin", "python");

function pyVerify(token: string, secret: string, nowMs?: number): boolean {
  const code = [
    "import sys; sys.path.insert(0, 'audio-service')",
    "import crossfade_token as ct",
    `print(ct.verify_token(${JSON.stringify(token)}, ${JSON.stringify(secret)}${nowMs != null ? `, now_ms=${nowMs}` : ""}))`,
  ].join("\n");
  const out = execFileSync(py, ["-c", code], {
    cwd: path.join(__dirname, ".."),
  })
    .toString()
    .trim();
  return out === "True";
}

const token = mintCrossfadeToken(SECRET);
assert.strictEqual(pyVerify(token, SECRET), true, "valid token verifies");
assert.strictEqual(pyVerify(token, "wrong-secret"), false, "wrong secret rejected");
assert.strictEqual(pyVerify(token + "x", SECRET), false, "tampered sig rejected");
const [exp, sig] = token.split(".");
assert.strictEqual(pyVerify(`${Number(exp) + 60000}.${sig}`, SECRET), false, "tampered exp rejected");
assert.strictEqual(
  pyVerify(token, SECRET, Number(exp) + 1),
  false,
  "expired token rejected"
);
console.log("✅ crossfade token mint/verify OK (TS ↔ Python)");
