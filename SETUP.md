# Setup & Provisioning — Music Genome Project

Status of every data source, how it authenticates, and the **gotchas we hit
while validating each one live**. Actual secrets live in `.env.local` (gitignored);
this file documents *what* is wired, not the values.

## Provisioned services

| Service | Auth model | What we need it for | Notes |
|---|---|---|---|
| **Neo4j Aura** (free) | URI + user + password | The knowledge graph (every artist MERGE'd) | Aura Free username = the **instance id**, not `neo4j`. Default DB works; no `NEO4J_DATABASE` needed. |
| **Ollama** (local) | none | LLM narrative + future embeddings | Default model `qwen2.5:14b` (good prose, no `<think>` tags). `llama3.1:8b`/`mistral:7b` are faster; `gemma4:26b` is highest quality. ~31s for a 180-word profile on 14b. |
| **MusicBrainz** | none (User-Agent only) | Artist relations, release-groups | Hard **1 req/sec** limit — client serializes + spaces calls. Must send a real `User-Agent`. |
| **Wikidata** | none (User-Agent) | Directional influence (P737) = family tree | Coverage uneven: descendants rich, "influenced by" often thin. Narrative only grounds on what exists. |
| **Last.fm** | API key | Similar artists + tags | Degrades gracefully if key absent. Shared secret NOT needed (read-only). |
| **Discogs** | Personal Access Token | Producer/engineer/mix credits | **No OAuth app needed** — PAT covers all read endpoints. Credits live on a master's `main_release`, NOT random regional pressings → pattern: `search type=master → /masters/{id} → main_release → /releases/{id}.extraartists`. 60 req/min authed. |
| **Genius** | Client Access Token (bearer) | Songwriter metadata | Token only (id/secret are for OAuth we don't use). ⚠️ API returns metadata + lyrics *URL* but **not lyric text** (licensing) — Songwriter Copilot must scrape the page or use referents/annotations. |
| **Setlist.fm** | API key | Concert setlist intelligence | ⚠️ Requires a real **User-Agent** or CloudFront returns 403 ForbiddenException (looks like an auth error but isn't). 2 req/sec, 1440/day. |
| **Spotify** | Client ID + Secret | Followers/popularity (Career Sim); user library (Personal DNA) | Client-credentials = public catalog only (search/artist/album). **Deprecated for new apps (2024-11-27): audio-features, audio-analysis, related-artists, recommendations, previews.** Don't build on those. |

## One manual step left (only when we build Playlist / Personal DNA)

Reading a user's *own* library needs the Authorization Code (user-login) flow.
In the Spotify dashboard for the app, **Edit**:

1. Add Redirect URI **exactly**: `http://127.0.0.1:3000/api/spotify/callback`
   (Spotify rejects `localhost` now — loopback IP only.)
2. Under **APIs used**, check **Web API**.
3. App starts in *Development mode* (fine) — up to 25 users you add under
   **User Management**. Extended quota needs 250k MAU, which we'll never hit /
   never need for personal use.

## Quick verification commands

```bash
npm run graph:init     # Neo4j reachable + constraints
npm run build          # typecheck everything
npm run dev            # http://localhost:3000  → search an artist
```
