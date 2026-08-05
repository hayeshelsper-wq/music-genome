# SAM Audio extraction service — CUDA runtime + gated HF weights baked in.
# Build needs a BuildKit secret `hf_token` whose account accepted the SAM Audio
# license on HF (facebook/sam-audio-base): HUMAN CHECKPOINT before first build.
# torch 2.13 pairs with current torchcodec (0.15) — torchcodec's native lib
# strictly matches its torch release; a mismatch surfaces as a misleading
# "Could not load libtorchcodec / FFmpeg" error.
FROM pytorch/pytorch:2.13.0-cuda12.6-cudnn9-runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 git && rm -rf /var/lib/apt/lists/*

# The 2.13 images use a PEP 668-managed system Python (no conda) — apt's
# FFmpeg shared libs are on the default loader path, which is exactly what
# torchcodec dlopens.
# torchcodec from PyPI is built against CUDA 13 (libnvrtc.so.13) — this image
# is cu126, so pre-install the cu126-matched wheel from PyTorch's index; the
# later resolve then sees it satisfied.
COPY requirements.txt .
RUN pip install --no-cache-dir --break-system-packages torchcodec \
      --index-url https://download.pytorch.org/whl/cu126 && \
    pip install --no-cache-dir --break-system-packages -r requirements.txt

ENV HF_HOME=/models
ARG SAM_AUDIO_MODEL=facebook/sam-audio-base
ENV SAM_AUDIO_MODEL=${SAM_AUDIO_MODEL}
COPY bake.py .
RUN --mount=type=secret,id=hf_token \
    HF_TOKEN=$(cat /run/secrets/hf_token 2>/dev/null || echo "$HF_TOKEN") python bake.py

COPY server.py .

ENV PORT=8080
ENV SAM_AUDIO_DEVICE=cuda
CMD uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080}
