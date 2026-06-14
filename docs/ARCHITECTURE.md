# Architecture

A deeper look at how The Music Genome Project is put together — the services, the
data model, the request lifecycles, and the design decisions behind them. For the
product/feature overview, see the [README](../README.md).

## Topology

Four deployable units, all on Google Cloud Run (scale‑to‑zero except `web`):

| Unit | Language / runtime | Access | Responsibility |
|---|---|---|---|
| `web` | Next.js 15 / Node | public, password‑gated | UI + API routes; the only public surface |
| `audio-service` | Python / FastAPI (CPU) | private (IAM) | all DSP, source separation, CLAP, tagging, transcription, stretch/shift |
| `musicgen` | Python / FastAPI (NVIDIA L4) | private (IAM) | text‑conditioned music generation |
| `flamingo` / `flamingo-afnext` | Python / FastAPI (NVIDIA L4) | private (IAM) | audio‑LLM clip description |

State lives outside the services:

- **Firestore (Native)** — assembled artist reports, the upload library, and per‑artist sonic fingerprints.
- **Cloud Storage** — uploaded audio files.
- **Secret Manager** — API keys + the login gate.
- **Artifact Registry / Cloud Build** — images + CI builds.

`web` is the only thing on the public internet; it brokers everything else.

## Service‑to‑service auth

The audio + GPU services are deployed `--no-allow-unauthenticated`. `web` calls
them with a **Google‑signed OIDC identity token** minted from the Cloud Run
metadata server (`src/lib/cloudRun.ts`), with the target service URL as the
audience; the runtime service account holds `roles/run.invoker` on each. Locally
there's no metadata server, so the helper no‑ops and calls go out plain to
`http://127.0.0.1:*`. Audio bytes are delivered to the audio‑service as **public
iTunes preview URLs** (or GCS objects) that it fetches directly — no inbound auth
plumbing, mirroring how Stem Lab already worked.

## Data model (Firestore)

| Collection | Key | Shape |
|---|---|---|
| `artistReports` | MBID | the fully‑assembled `ArtistDnaReport` (family/collaborator graphs, similar, tags, timeline) |
| `uploads` | upload id | DSP `features`, `tags`, producer `review`, Flamingo read, `key`/`tempo`, and a **CLAP `embedding`** stored as a Firestore *vector* (for KNN) |
| `artistSonic` | MBID | a per‑artist sonic fingerprint: CLAP centroid + aggregate DSP over top tracks (powers Trails / Lineage; cached so repeats are instant) |

The graphs are all 1‑hop, so the app stores a denormalized report document per
artist rather than running a graph database — see *Decisions* below.

## Request lifecycles

**Artist DNA ingest** (`GET /api/artist/[mbid]`) — if unseen, fan out to
MusicBrainz (relations + release‑groups, throttled 1 req/s), Wikidata (P737
influence via SPARQL), and Last.fm (similar + tags), assemble the report in
memory, and persist it. Subsequent loads read the Firestore document directly.

**Ask the Genome** (`POST /api/ask`) — a manual agentic loop over the Anthropic
Messages API. ~8 tools wrap existing capabilities (`search_artist`,
`get_artist_dna`, `get_artist_top_tracks`, `search_by_sound`, `find_sonic_twins`,
`get_track_details`, `list_my_library`, `get_song_credits_and_lyrics`). Each turn
streams text + tool‑call events to the browser as NDJSON; tool results are fed
back until the model stops calling tools.

**Genome Studio** (`POST /api/studio/generate`) — build a reference fingerprint
(a library track's stored DSP+vector, or an artist's representative top track
analyzed on the fly) → assemble a prompt → `musicgen` generates a clip → push the
clip through the audio‑service `/upload` analysis → score generated‑vs‑reference
(tempo octave‑tolerant, key, brightness, CLAP cosine) into a weighted DNA match.

**Influence Trails / Lineage Walk** — `computeArtistSonic` builds (or reads from
the `artistSonic` cache) each artist's CLAP centroid + aggregate DSP over their
top tracks; trails compare two, lineage traverses the influence graph hop‑by‑hop.
Both add a Claude narration grounded strictly in the measured deltas.

**Living Map** — built offline by `scripts/build-music-map.ts`: a curated corpus
→ iTunes previews → CLAP embeddings → PCA‑2D → `public/music-map.json` (client)
plus `src/data/musicMapEmbeddings.json` (server‑side, for "drop your own track,"
which places an upload by similarity‑weighted nearest neighbors).

**Mashup Lab** (`POST /api/mashup`) — the audio‑service separates both previews
with Demucs, conforms the acapella to the bed (Rubber Band time‑stretch to its
tempo + pitch‑shift to its key), mixes, and returns one clip.

## The shared backbone

- **CLAP** (LAION `clap-htsat-unfused`) — one 512‑dim text+audio space behind
  search‑by‑sound, sonic twins, Trails/Lineage similarity, the Living Map, the
  Mashup matcher, and the Studio's verify step.
- **DSP** (librosa) — the measured "ground truth" (tempo/key/brightness/…).
- **Demucs** — separation for Stem Lab + Mashup. **MusicGen** — generation.
  **Audio Flamingo** — clip description. **Claude `opus-4-8`** — all prose +
  the agent loop.

## Caching

- audio‑service `/analyze` and `/stems` cache by preview URL (in‑process).
- `artistSonic` fingerprints persist in Firestore — first trail/lineage for an
  artist is slow; repeats are instant.
- artist reports persist in Firestore after first ingest.
- generation/mashup are not cached (each run re‑separates/re‑generates).

## Decisions & tradeoffs

- **Firestore over Neo4j.** The MVP used Neo4j, but every query is a 1‑hop
  lookup and Aura Free cold‑starts badly. A denormalized report document per
  artist is simpler, serverless, and scale‑to‑zero. Upload CLAP vectors do use
  Firestore's native vector field for KNN.
- **Preview URLs as the audio bus.** Public 30‑second iTunes previews are
  fetched directly by the private audio‑service — no signed URLs or inbound auth
  to broker, and licensing‑safe at 30s.
- **Scale‑to‑zero GPU.** L4 services cost nothing idle; the price is cold‑start
  latency on the first generation/mashup. Acceptable for a demo; warm before a
  live walkthrough or pin `--min-instances=1`.
- **Anthropic for the agent, Ollama for prose fallback.** Reliable tool use needs
  a strong model, so Ask the Genome requires `ANTHROPIC_API_KEY`; lighter prose
  (DNA narratives) falls back to local Ollama when no key is set.
- **Generate → verify.** The Studio deliberately re‑measures generated audio with
  the same pipeline that measured the target — turning "did it sound right?" into
  a number, which is the harder, more interesting half of music generation.

## Build & deploy

`deploy/deploy.sh` enables APIs, provisions Firestore + Artifact Registry, builds
all four images via Cloud Build, and deploys each service with the right
CPU/GPU/scaling/IAM. `deploy/push-secrets.sh` loads keys + the login gate into
Secret Manager. The Living‑Map corpus is rebuilt with
`scripts/build-music-map.ts` against an audio‑service that exposes CLAP.
