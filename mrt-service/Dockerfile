# Magenta RealTime crossfader — CUDA + JAX + magenta-rt, weights baked.
# Weights: google/magenta-realtime-2 (CC-BY 4.0, ungated) — attribution in the
# repo README and the /crossfade page footer. Code Apache-2.0.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3-pip ffmpeg libsndfile1 curl git \
    && rm -rf /var/lib/apt/lists/*

RUN python3.11 -m venv /venv
ENV PATH=/venv/bin:$PATH

# upstream: magenta-rt 2.0.3 on PyPI (requires-python >=3.11); JAX CUDA wheels.
RUN pip install --no-cache-dir "magenta-rt==2.0.3" "jax[cuda12]" \
    fastapi "uvicorn[standard]" websockets soundfile numpy

# Bake the model weights (mrt models download fetches to ~/Documents/Magenta;
# set HOME so the path is deterministic in the image). Unauthenticated HF pulls
# get rate-limited mid-download, so the token is required — and a missing
# checkpoint must FAIL the build, not ship a weightless image.
ENV HOME=/models
# `mrt models download` is an interactive menu (simple-term-menu) — unusable in
# a build. `mrt models init` fetches the small shared resources fine; the big
# checkpoints come straight from HF into the same tree the CLI would use.
RUN --mount=type=secret,id=hf_token \
    export HF_TOKEN=$(cat /run/secrets/hf_token) && \
    mrt models init && \
    python -c "from huggingface_hub import snapshot_download; import os; \
      snapshot_download('google/magenta-realtime-2', token=os.environ.get('HF_TOKEN'), \
      local_dir='/models/Documents/Magenta/magenta-rt-v2')" && \
    test -f /models/Documents/Magenta/magenta-rt-v2/checkpoints/mrt2_base.safetensors

COPY server.py .

ENV PORT=8080
ENV MRT_MODEL=mrt2_base
ENV CHUNK_S=2.0
CMD uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080}
