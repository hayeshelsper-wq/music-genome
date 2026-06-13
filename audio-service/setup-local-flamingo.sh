#!/usr/bin/env bash
# One-time setup for the local Audio Flamingo 3 sidecar.
# Creates an isolated Python 3.11 venv ON THE EXTERNAL SSD and installs torch +
# transformers (from git — AF3's HF class isn't in a PyPI release yet) + the
# server deps. The ~16GB model itself downloads on first use into $BASE/hf-cache,
# also on the SSD, so nothing heavy touches the system drive.
set -euo pipefail

# Storage is split across two drives, on purpose:
#  - VENV  -> a proper filesystem (HFS+/APFS). ExFAT CORRUPTS venvs: pip's many
#    small files + non-atomic renames produced corrupt source files and a 20GB
#    bloated torch on the ExFAT SSD. So the venv goes on the Pro Tools drive.
#  - CACHE -> the big ~16GB model. ExFAT handles a few large, checksum-verified
#    files fine, so this lives on the Extreme SSD (the offload drive).
# Override either with MUSIC_FLAMINGO_VENV / MUSIC_FLAMINGO_CACHE.
VENV="${MUSIC_FLAMINGO_VENV:-/Volumes/Protools/music-genome-flamingo/venv}"
CACHE="${MUSIC_FLAMINGO_CACHE:-/Volumes/Extreme SSD/music-genome-flamingo/hf-cache}"

echo "▸ venv:  $VENV"
echo "▸ cache: $CACHE"
mkdir -p "$CACHE"
mkdir -p "$(dirname "$VENV")"

if [ ! -x "$VENV/bin/python" ]; then
  echo "▸ creating Python 3.11 venv…"
  python3.11 -m venv "$VENV"
fi

PY="$VENV/bin/python"
echo "▸ python: $($PY --version)"

"$PY" -m pip install --upgrade pip wheel

# torch/torchaudio for Apple Silicon (default index ships arm64 MPS wheels)
echo "▸ installing torch + torchaudio…"
"$PY" -m pip install "torch>=2.4" torchaudio

# AF3 support lives on transformers main, not a release yet.
echo "▸ installing transformers (git main) + accelerate…"
"$PY" -m pip install "git+https://github.com/huggingface/transformers" accelerate

echo "▸ installing sidecar server deps…"
"$PY" -m pip install fastapi "uvicorn[standard]" soundfile librosa httpx pydantic

echo "▸ verifying the AF3 class imports…"
"$PY" - <<'PYCHECK'
from transformers import AudioFlamingo3ForConditionalGeneration, AutoProcessor  # noqa: F401
import torch
print("   AF3 class OK · torch", torch.__version__, "· mps", torch.backends.mps.is_available())
PYCHECK

echo "✅ setup complete. Start it with:  ./run-local-flamingo.sh"
echo "   (first /describe call downloads ~16GB into $CACHE)"
