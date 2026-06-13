import neo4j, { Driver, Session } from "neo4j-driver";

let driver: Driver | null = null;

/** Whether NEO4J_* env is present — lets callers tell "not configured" apart from
 *  "configured but unreachable" (e.g. a paused Aura Free instance). */
export function isNeo4jConfigured(): boolean {
  return !!(
    process.env.NEO4J_URI &&
    process.env.NEO4J_USER &&
    process.env.NEO4J_PASSWORD
  );
}

/** Transient connectivity errors — typically a cold/paused Aura instance resuming
 *  or a dropped pooled connection. These are worth retrying. */
export function isTransientNeo4jError(e: unknown): boolean {
  const m =
    (e as { code?: string })?.code +
    " " +
    ((e as { message?: string })?.message || String(e));
  return /ServiceUnavailable|SessionExpired|TransientError|routing|Unable to (connect|acquire)|acquisition timed out|ECONNREFUSED|ECONNRESET|Connection (acquisition|was closed)/i.test(
    m
  );
}

export function getDriver(): Driver {
  if (driver) return driver;
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error(
      "Neo4j env not set. Copy .env.local.example to .env.local and fill NEO4J_URI/USER/PASSWORD."
    );
  }
  driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    // Keep connections lean; the graph is small per-artist.
    maxConnectionPoolSize: 20,
    disableLosslessIntegers: true, // return plain JS numbers, not Integer
    // Aura Free pauses when idle; give a resuming instance time to answer.
    connectionAcquisitionTimeout: 60_000,
  });
  return driver;
}

export async function withSession<T>(
  fn: (s: Session) => Promise<T>,
  retries = 2
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const session = getDriver().session();
    try {
      return await fn(session);
    } catch (e) {
      if (attempt < retries && isTransientNeo4jError(e)) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw e;
    } finally {
      await session.close();
    }
  }
}

/** Idempotent schema: uniqueness on the canonical MusicBrainz id. */
export async function ensureConstraints(): Promise<void> {
  await withSession(async (s) => {
    await s.run(
      `CREATE CONSTRAINT artist_mbid IF NOT EXISTS
       FOR (a:Artist) REQUIRE a.mbid IS UNIQUE`
    );
    await s.run(
      `CREATE CONSTRAINT genre_name IF NOT EXISTS
       FOR (g:Genre) REQUIRE g.name IS UNIQUE`
    );
  });
}

/** True if we've already ingested this artist (so we can serve from the graph). */
export async function isIngested(mbid: string): Promise<boolean> {
  return withSession(async (s) => {
    const r = await s.run(
      `MATCH (a:Artist {mbid: $mbid}) RETURN a.ingestedAt AS at`,
      { mbid }
    );
    return r.records.length > 0 && r.records[0].get("at") != null;
  });
}
