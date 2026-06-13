# Deploying to Google Cloud

All serverless, all GCP, all scale-to-zero:

| Service | Where | Notes |
|---|---|---|
| `web` (Next.js) | Cloud Run (public) | the site |
| `audio-service` (FastAPI, CPU) | Cloud Run (private) | librosa / demucs / whisper |
| `flamingo` (Audio Flamingo 3, 8B) | Cloud Run + **NVIDIA L4** (private) | CUDA → fast; scale-to-zero |
| graph data | **Firestore** (Native) | replaced Neo4j; no idle pause |
| keys | **Secret Manager** | |
| images | **Artifact Registry** | built by Cloud Build |

The web app calls the audio-service, which calls flamingo — both **private**, authorized
by IAM ID tokens (handled in `src/lib/cloudRun.ts` and `audio-service/flamingo.py`).

---

## What I need from you
- Your **GCP project ID** (and a preferred region — default `us-central1`).
- Confirmation you've done the **one-time setup** below (auth, billing, secrets).
  I never need the secret *values* — you load those straight into Secret Manager.

## One-time setup (you run these)

1. **Install gcloud + auth.** In this chat you can run it inline:
   ```
   ! gcloud auth login
   ! gcloud auth application-default login
   ```
2. **Create a project + enable billing** (Console → Billing). Note the project ID.
3. **Create the secrets** (paste each value when prompted):
   ```bash
   PROJECT=your-project-id
   for S in SPOTIFY_CLIENT_ID SPOTIFY_CLIENT_SECRET LASTFM_API_KEY \
            GENIUS_ACCESS_TOKEN ANTHROPIC_API_KEY HF_TOKEN \
            AUTH_PASSWORD AUTH_SECRET; do
     printf "Enter $S: "; read -rs VAL; echo
     printf "%s" "$VAL" | gcloud secrets create "$S" --project="$PROJECT" \
       --replication-policy=automatic --data-file=- 2>/dev/null \
     || printf "%s" "$VAL" | gcloud secrets versions add "$S" --project="$PROJECT" --data-file=-
   done
   ```
   - `HF_TOKEN`: a Hugging Face read token (huggingface.co/settings/tokens) so the
     GPU service can pull the model.
   - `ANTHROPIC_API_KEY`: the cloud LLM for the producer critique (replaces local Ollama).
   - `AUTH_PASSWORD`: the **access password** for the private preview — share only
     with the people you want to let in.
   - `AUTH_SECRET`: a random signing key for the login cookie. Generate one with
     `openssl rand -base64 32` and paste it.

   The whole site is gated behind a login page until you enter `AUTH_PASSWORD`, so
   bots can't reach any API route (or trigger the GPU). The gate is **off** unless
   both `AUTH_PASSWORD` and `AUTH_SECRET` are set, so local dev stays open.

   Also set a **billing budget alert** (Console → Billing → Budgets) as a backstop
   — e.g. notify at $20/mo. With scale-to-zero + the login gate + max-instances
   caps (flamingo ≤2), runaway cost is already well-contained.

## Deploy
```bash
PROJECT=your-project-id ./deploy/deploy.sh
```
It enables APIs, creates Firestore + the Artifact Registry repo, builds all three
images, and deploys the three services wired together. It prints the public web URL.

## After the first deploy
- Add `https://<web-url>/api/spotify/callback` to your **Spotify app's Redirect URIs**
  (Dev-Mode 5-user cap still applies — add your + interviewers' emails under User Management).
- Set `MUSICBRAINZ_USER_AGENT` to a real contact (edit `deploy.sh`), per MB policy.

## Model weights (cold-start tradeoff)
By default the GPU service **downloads** the ~16 GB model from HF on first request
(slower first cold start). For snappier cold starts, **bake it into the image** —
uncomment OPTION A in `audio-service/Dockerfile.flamingo` and build with the HF
token mounted. Either way, with scale-to-zero you only pay GPU (~$0.67/hr) while a
request is actually running.

## Cost (demo-scale)
- web + audio-service: ~$0–10/mo (scale to zero).
- flamingo L4: only while running; pennies per demo at scale-to-zero. Don't pin it warm.
- Firestore: effectively free at this volume.
- Anthropic: cents per critique.

## Local dev after the Firestore migration
The graph features now use Firestore instead of Neo4j. To run them locally:
- `gcloud auth application-default login` **+** `export GOOGLE_CLOUD_PROJECT=your-project`
  (uses the real cloud Firestore), **or**
- run the Firestore emulator: `gcloud emulators firestore start` and set
  `FIRESTORE_EMULATOR_HOST` accordingly.

The Sonic DNA previews and local Flamingo work with no store at all (graceful degrade).
