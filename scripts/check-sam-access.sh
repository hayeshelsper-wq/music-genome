#!/usr/bin/env bash
# Which SAM Audio repos can the deployed HF_TOKEN download?
export CLOUDSDK_PYTHON=${CLOUDSDK_PYTHON:-/opt/homebrew/bin/python3.11}
TOK=$(gcloud secrets versions access latest --secret=HF_TOKEN --project=project-ac194633-c061-471f-b56 2>/dev/null)
for m in sam-audio-base sam-audio-small sam-audio-large sam-audio-large-tv; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOK" \
    "https://huggingface.co/facebook/$m/resolve/main/config.json")
  echo "$m: $code"
done
