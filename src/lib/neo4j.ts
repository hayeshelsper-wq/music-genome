import neo4j, { Driver, Session } from "neo4j-driver";

let driver: Driver | null = null;

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
  });
  return driver;
}

export async function withSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  const session = getDriver().session();
  try {
    return await fn(session);
  } finally {
    await session.close();
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
