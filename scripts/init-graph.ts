/**
 * scripts/init-graph.ts
 *
 * One-shot Neo4j bootstrap for the Artist DNA Report.
 * Run with:  npm run graph:init
 *
 * What it does:
 *   1. Loads NEO4J_* from .env.local (a plain `tsx` script doesn't get Next.js'
 *      automatic env loading, so we parse the file ourselves — no extra deps).
 *   2. Verifies the database is actually reachable (fast, friendly failure if not).
 *   3. Applies the idempotent schema constraints from src/lib/neo4j.ts.
 *
 * Safe to run repeatedly — every statement is IF NOT EXISTS.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// --- 1. Load .env.local into process.env (only keys not already set) ----------
function loadEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(
      "✗ No .env.local found.\n" +
        "  Copy the template first:  cp .env.local.example .env.local\n" +
        "  then fill in NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD."
    );
    process.exit(1);
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip matching surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvLocal();

// Import AFTER env is loaded — getDriver() reads process.env at call time, but
// importing here keeps the failure ordering clean (env check above runs first).
import { getDriver, ensureConstraints, withSession } from "../src/lib/neo4j";

async function main(): Promise<void> {
  const uri = process.env.NEO4J_URI ?? "(unset)";
  console.log(`→ Connecting to Neo4j at ${uri} …`);

  const driver = getDriver();
  try {
    // verifyConnectivity gives a clear network/auth error before we run DDL.
    await driver.verifyConnectivity();
    console.log("✓ Connection OK");
  } catch (e: any) {
    console.error(
      `✗ Could not reach Neo4j: ${e.message}\n` +
        "  • Aura:  check the neo4j+s:// URI and that the instance is running.\n" +
        "  • Local: is it up?  `brew services start neo4j`  (bolt://localhost:7687)\n" +
        "  • Auth:  confirm NEO4J_USER / NEO4J_PASSWORD in .env.local."
    );
    await driver.close();
    process.exit(1);
  }

  console.log("→ Applying schema constraints …");
  await ensureConstraints();

  // Report what's now in place so the run is legible.
  const constraints = await withSession(async (s) => {
    const r = await s.run("SHOW CONSTRAINTS YIELD name RETURN name ORDER BY name");
    return r.records.map((rec) => rec.get("name") as string);
  });
  console.log(`✓ Schema ready (${constraints.length} constraint(s)):`);
  for (const name of constraints) console.log(`    • ${name}`);

  await driver.close();
  console.log("\nDone. The graph is ready — start the app with `npm run dev`.");
}

main().catch(async (e) => {
  console.error("✗ init-graph failed:", e?.message ?? e);
  try {
    await getDriver().close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
