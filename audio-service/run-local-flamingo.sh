#!/usr/bin/env bash
# Start the local Audio Flamingo 3 sidecar (port 8077). Points HF_HOME at the
# external SSD so the ~16GB model cache lives there, not on the system drive.
# Leave this running alongside the main audio-service.
set -euo pipefail

# venv on a proper filesystem; model cache on the external offload SSD.
VENV="${MUSIC_FLAMINGO_VENV:-/Volumes/Protools/music-genome-flamingo/venv}"
CACHE="${MUSIC_FLAMINGO_CACHE:-/Volumes/Extreme SSD/music-genome-flamingo/hf-cache}"

if [ ! -x "$VENV/bin/python" ]; then
  echo "venv missing — run ./setup-local-flamingo.sh first" >&2
  exit 1
fi

export HF_HOME="$CACHE"
export PYTORCH_ENABLE_MPS_FALLBACK=1
export TOKENIZERS_PARALLELISM=false

cd "$(dirname "$0")"
echo "▸ HF_HOME=$HF_HOME"
echo "▸ sidecar on http://127.0.0.1:8077  (first call downloads the model)"
exec "$VENV/bin/python" -m uvicorn flamingo_local_server:app --host 127.0.0.1 --port "${MUSIC_FLAMINGO_LOCAL_PORT:-8077}"
