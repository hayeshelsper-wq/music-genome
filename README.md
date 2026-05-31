# The Music Genome Project — Artist DNA Report (MVP)

First vertical slice of the larger vision: search any artist and get a living
**DNA report** — influence family tree, collaborator network, genre evolution,
and an LLM-written profile — all backed by a real **Neo4j knowledge graph** that
the other planned pages (Producer Breakdown, Discovery Graph, Career Simulator…)
will reuse.

## Why these data sources

Spotify **deprecated** audio-features, related-artists, and recommendations for
new apps on 2024-11-27, so the "intelligence" can't come from Spotify anymore.
This MVP gets it from sources that are actually open:

| Section | Source |
|---|---|
| Influence family tree (directional ↑↓) | **Wikidata** P737 "influenced by" |
| Collaborator / member / producer network | **MusicBrainz** artist relations |
| "Sounds adjacent" + tags | **Last.fm** similar artists / top tags |
| Genre evolution timeline | **MusicBrainz** release-groups + genres |
| DNA profile prose | **Ollama** (local) / Anthropic / OpenAI |

The graph is the moat: every artist you view is MERGE-ed into Neo4j, so you can
eventually ask cross-artist questions ("influenced by Brian Wilson, undiscovered
by indie listeners").

## Setup

```bash
cp .env.local.example .env.local      # then fill it in
npm install
```

1. **Neo4j** — easiest is a free **Neo4j Aura** instance
   (https://neo4j.com/cloud/aura-free/); paste its `neo4j+s://…` URI + password
   into `.env.local`. Or run locally: `brew install neo4j && neo4j start`
   (URI `bolt://localhost:7687`, set a password with `cypher-shell`).
2. **Last.fm key** (optional but recommended) — instant free key at
   https://www.last.fm/api/account/create.
3. **LLM** — defaults to local **Ollama**. Make sure it's running and you have a
   model: `ollama pull llama3.1`. Or set `LLM_PROVIDER=anthropic|openai` + key.
4. **MusicBrainz** — no key; just keep a real contact in
   `MUSICBRAINZ_USER_AGENT` (their rules). Calls are throttled to 1/sec.

```bash
npm run dev      # http://localhost:3000
```

Search an artist → the first load ingests from all sources (a few seconds, gated
by MusicBrainz's rate limit), writes the graph, and renders. Subsequent loads
read straight from Neo4j. Click any node in the family/collaborator graph to dive
into that artist's genome.

## Architecture

```
src/lib/
  musicbrainz.ts  search, artist relations, release-groups (1 req/s throttle)
  wikidata.ts     P737 influence, both directions, one SPARQL call
  lastfm.ts       similar artists + tags (degrades gracefully w/o key)
  llm.ts          ollama | anthropic | openai
  ingest.ts       fan-out fetch -> MERGE into Neo4j -> read report back
  neo4j.ts        driver + constraints
  narrative.ts    grounded prompt over the assembled graph
src/app/
  page.tsx                       search
  artist/[mbid]/page.tsx         the DNA report
  api/search                     MB artist search
  api/artist/[mbid]              ingest-if-needed + report
  api/artist/[mbid]/narrative    LLM profile
src/components/Graph.tsx         react-force-graph, click-to-explore
```

## Next slices to snap on

- **Producer Breakdown** — add Discogs credits + local audio analysis (Essentia).
- **Discovery Graph** — graph traversal over the Neo4j edges you're already storing.
- **Playlist / Personal DNA** — Spotify OAuth for *your own* library (still allowed).
