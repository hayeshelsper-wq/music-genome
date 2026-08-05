# SAM Audio extraction service — CUDA runtime + gated HF weights baked in.
# Build needs a BuildKit secret `hf_token` whose account accepted the SAM Audio
# license on HF (facebook/sam-audio-base): HUMAN CHECKPOINT before first build.
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 git && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

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
