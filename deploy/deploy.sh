#!/usr/bin/env bash
# One-shot deploy of the whole app to Google Cloud:
#   web (Cloud Run, public) → audio-service (Cloud Run CPU, private)
#                           → flamingo (Cloud Run + NVIDIA L4, private, scale-to-zero)
#   data in Firestore · secrets in Secret Manager · images in Artifact Registry
#
# Prereqs (see deploy/README.md): gcloud auth, billing on, secrets created.
# Usage:  PROJECT=your-project-id ./deploy/deploy.sh
set -euo pipefail

PROJECT="${PROJECT:-}"
REGION="${REGION:-us-central1}"   # Tier-1 region that offers L4 GPUs
[ -z "$PROJECT" ] && { echo "Set PROJECT=your-gcp-project-id"; exit 1; }

REPO="music-genome"
AR="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"
TAG="${TAG:-$(date +%Y%m%d-%H%M%S)}"   # override to reuse a prior build

gcloud config set project "$PROJECT" >/dev/null
PROJNUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUN_SA="${PROJNUM}-compute@developer.gserviceaccount.com"  # default Cloud Run identity

echo "▸ enabling APIs…"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com firestore.googleapis.com secretmanager.googleapis.com

echo "▸ Firestore (Native) database…"
gcloud firestore databases describe --database="(default)" >/dev/null 2>&1 || \
  gcloud firestore databases create --location="$REGION" --type=firestore-native

echo "▸ Artifact Registry repo…"
gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION"

echo "▸ granting the runtime SA Firestore + Secret access…"
gcloud projects add-iam-policy-binding "$PROJECT" --quiet \
  --member="serviceAccount:${RUN_SA}" --role=roles/datastore.user >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" --quiet \
  --member="serviceAccount:${RUN_SA}" --role=roles/secretmanager.secretAccessor >/dev/null
# Cloud Build runs as the Compute default SA — on new projects it needs these to
# read the uploaded source, push images, and write logs.
for ROLE in roles/cloudbuild.builds.builder roles/storage.objectViewer \
            roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT" --quiet \
    --member="serviceAccount:${RUN_SA}" --role="$ROLE" >/dev/null
done

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "▸ building images (Cloud Build)…"
  gcloud builds submit --config=cloudbuild.yaml \
    --substitutions=_AR="$AR",_TAG="$TAG" .
else
  echo "▸ SKIP_BUILD=1 — reusing images tagged $TAG"
fi

echo "▸ deploying flamingo (L4 GPU, private, scale-to-zero)…"
gcloud run deploy flamingo \
  --image="$AR/flamingo:$TAG" --region="$REGION" \
  --gpu=1 --gpu-type=nvidia-l4 --no-gpu-zonal-redundancy \
  --cpu=8 --memory=24Gi --concurrency=1 \
  --min-instances=0 --max-instances=1 --timeout=600 \
  --no-allow-unauthenticated \
  --service-account="$RUN_SA" \
  --set-env-vars=MUSIC_FLAMINGO_DEVICE=cuda,HF_HOME=/models \
  --set-secrets=HF_TOKEN=HF_TOKEN:latest
FLAMINGO_URL="$(gcloud run services describe flamingo --region="$REGION" --format='value(status.url)')"

echo "▸ deploying audio-service (CPU, private)…"
# NOTE (2026-06-06): production now uses the **Audio Flamingo NEXT captioner**
# served by the separate `flamingo-afnext` service, not this AF3 `flamingo`.
# This line points the audio-service at AF3 — after running deploy.sh, re-apply
# the AF-Next wiring:
#   gcloud run services update audio-service --region="$REGION" \
#     --update-env-vars=MUSIC_FLAMINGO_LOCAL_URL="$(gcloud run services describe flamingo-afnext --region="$REGION" --format='value(status.url)')/describe"
#   gcloud run services add-iam-policy-binding flamingo-afnext --region="$REGION" \
#     --member="serviceAccount:${RUN_SA}" --role=roles/run.invoker
gcloud run deploy audio-service \
  --image="$AR/audio:$TAG" --region="$REGION" \
  --cpu=4 --memory=8Gi --concurrency=4 \
  --min-instances=0 --max-instances=1 --timeout=300 \
  --no-allow-unauthenticated \
  --service-account="$RUN_SA" \
  --set-env-vars=MUSIC_FLAMINGO_LOCAL=1,MUSIC_FLAMINGO_LOCAL_URL="${FLAMINGO_URL}/describe"
AUDIO_URL="$(gcloud run services describe audio-service --region="$REGION" --format='value(status.url)')"

echo "▸ allowing audio-service → flamingo…"
gcloud run services add-iam-policy-binding flamingo --region="$REGION" --quiet \
  --member="serviceAccount:${RUN_SA}" --role=roles/run.invoker >/dev/null

echo "▸ deploying musicgen (L4 GPU, private, scale-to-zero)…"
# The generative half of the Genome Studio (/studio): MusicGen on an L4. Private
# (IAM-gated); the web app calls it with a Google-signed ID token. Scales to zero.
gcloud run deploy musicgen \
  --image="$AR/musicgen:$TAG" --region="$REGION" \
  --gpu=1 --gpu-type=nvidia-l4 --no-gpu-zonal-redundancy \
  --cpu=8 --memory=24Gi --concurrency=1 \
  --min-instances=0 --max-instances=1 --timeout=300 \
  --no-allow-unauthenticated \
  --service-account="$RUN_SA" \
  --set-env-vars=MUSICGEN_DEVICE=cuda
MUSICGEN_URL="$(gcloud run services describe musicgen --region="$REGION" --format='value(status.url)')"

echo "▸ deploying web (public)…"
# timeout=600: "Ask the Genome" (/api/ask) streams an agentic loop that can chain
# several tool calls and, worst case, ingest a never-seen artist mid-turn
# (MusicBrainz 1 req/s ≈ 70s). On self-hosted Next this Cloud Run timeout is the
# real ceiling (route maxDuration is advisory), so give the stream headroom.
gcloud run deploy web \
  --image="$AR/web:$TAG" --region="$REGION" \
  --cpu=1 --memory=1Gi --min-instances=0 --max-instances=4 --timeout=600 \
  --allow-unauthenticated \
  --service-account="$RUN_SA" \
  --set-env-vars=AUDIO_SERVICE_URL="$AUDIO_URL",MUSICGEN_URL="$MUSICGEN_URL",GOOGLE_CLOUD_PROJECT="$PROJECT",LLM_PROVIDER=anthropic,ANTHROPIC_MODEL=claude-opus-4-8,MUSICBRAINZ_USER_AGENT="MusicGenome/1.0 ( hayeshelsper@gmail.com )" \
  --set-secrets=SPOTIFY_CLIENT_ID=SPOTIFY_CLIENT_ID:latest,SPOTIFY_CLIENT_SECRET=SPOTIFY_CLIENT_SECRET:latest,LASTFM_API_KEY=LASTFM_API_KEY:latest,GENIUS_ACCESS_TOKEN=GENIUS_ACCESS_TOKEN:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,AUTH_PASSWORD=AUTH_PASSWORD:latest,AUTH_SECRET=AUTH_SECRET:latest
WEB_URL="$(gcloud run services describe web --region="$REGION" --format='value(status.url)')"

echo "▸ allowing web → audio-service + musicgen, setting Spotify redirect…"
gcloud run services add-iam-policy-binding audio-service --region="$REGION" --quiet \
  --member="serviceAccount:${RUN_SA}" --role=roles/run.invoker >/dev/null
gcloud run services add-iam-policy-binding musicgen --region="$REGION" --quiet \
  --member="serviceAccount:${RUN_SA}" --role=roles/run.invoker >/dev/null
gcloud run services update web --region="$REGION" \
  --update-env-vars=SPOTIFY_REDIRECT_URI="${WEB_URL}/api/spotify/callback" >/dev/null

echo
echo "✅ deployed."
echo "   web:      $WEB_URL"
echo "   audio:    $AUDIO_URL   (private)"
echo "   flamingo: $FLAMINGO_URL   (private · L4 · scale-to-zero)"
echo
echo "⚠  Add this to your Spotify app's Redirect URIs:"
echo "     ${WEB_URL}/api/spotify/callback"
