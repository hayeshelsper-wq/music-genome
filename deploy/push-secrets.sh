#!/usr/bin/env bash
# Push deployment secrets into GCP Secret Manager:
#   - 6 API keys read from .env.local (Spotify x2, Last.fm, Genius, Anthropic, HF)
#   - the login-gate pair AUTH_PASSWORD / AUTH_SECRET (passed as env vars; if
#     AUTH_SECRET is omitted, a random one is generated)
# Re-running just adds a new version (safe to repeat / rotate).
#
# Usage:  AUTH_PASSWORD='your-password' ./deploy/push-secrets.sh
# NB: deliberately no `set -e` — the `[ test ] && cmd` / `${VAR:-$(...)}` patterns
# below return non-zero on the normal path, which -e would treat as a fatal error.
# `put` handles gcloud create-or-add-version explicitly instead.
set -uo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ENV_FILE="${ENV_FILE:-.env.local}"
[ -z "$PROJECT" ] && { echo "No project set (gcloud config set project ...)"; exit 1; }

echo "▸ project: $PROJECT"
echo "▸ enabling Secret Manager API…"
gcloud services enable secretmanager.googleapis.com --project="$PROJECT" >/dev/null

# read KEY=value from the env file (handles '=' in values, strips surrounding quotes)
getval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//'; }

put() {  # name value
  local name="$1" val="$2"
  if [ -z "$val" ]; then echo "  ⚠ $name: empty — skipped"; return; fi
  if printf '%s' "$val" | gcloud secrets create "$name" --project="$PROJECT" \
        --replication-policy=automatic --data-file=- >/dev/null 2>&1; then
    echo "  ✓ $name (created)"
  else
    printf '%s' "$val" | gcloud secrets versions add "$name" --project="$PROJECT" --data-file=- >/dev/null
    echo "  ✓ $name (new version)"
  fi
}

echo "▸ from $ENV_FILE:"
for k in SPOTIFY_CLIENT_ID SPOTIFY_CLIENT_SECRET LASTFM_API_KEY \
         GENIUS_ACCESS_TOKEN ANTHROPIC_API_KEY HF_TOKEN; do
  put "$k" "$(getval "$k")"
done

echo "▸ login gate:"
AUTH_PASSWORD="${AUTH_PASSWORD:-$(getval AUTH_PASSWORD)}"
AUTH_SECRET="${AUTH_SECRET:-$(getval AUTH_SECRET)}"
if [ -z "$AUTH_SECRET" ]; then AUTH_SECRET="$(openssl rand -base64 32)"; fi
if [ -z "$AUTH_PASSWORD" ]; then echo "  ✗ set AUTH_PASSWORD env var"; exit 1; fi
put AUTH_PASSWORD "$AUTH_PASSWORD"
put AUTH_SECRET "$AUTH_SECRET"

echo
echo "✅ secrets in project $PROJECT:"
gcloud secrets list --project="$PROJECT" --format="value(name)"
