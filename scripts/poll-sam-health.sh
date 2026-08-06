#!/usr/bin/env bash
# Poll sam-audio /health?load=1 until loaded with no error (or 20 tries).
export CLOUDSDK_PYTHON=${CLOUDSDK_PYTHON:-/opt/homebrew/bin/python3.11}
for i in $(seq 1 20); do
  TOK=$(gcloud auth print-identity-token 2>/dev/null)
  out=$(curl -s -H "Authorization: Bearer $TOK" --max-time 20 "https://sam-audio-717795396324.us-central1.run.app/health?load=1")
  echo "try $i: $out"
  case "$out" in
    *'"loaded":true,"error":null'*) echo LOADED; exit 0;;
    *'"error":"'*) echo "LOAD ERROR"; exit 1;;
  esac
  sleep 25
done
echo "NOT LOADED after 20 tries"
exit 1
