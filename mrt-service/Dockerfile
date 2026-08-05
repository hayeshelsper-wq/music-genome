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
# set HOME so the path is deterministic in the image).
ENV HOME=/models
RUN mrt models init && mrt models download || \
    echo "WARN: weight download failed at build — service will fetch at cold start"

COPY server.py .

ENV PORT=8080
ENV MRT_MODEL=mrt2_base
ENV CHUNK_S=2.0
CMD uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080}
