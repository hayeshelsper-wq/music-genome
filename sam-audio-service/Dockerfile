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

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# torchcodec (a sam-audio dep) dlopens FFmpeg SHARED LIBS; the conda env's
# loader path doesn't see apt's ffmpeg, so install FFmpeg into conda too.
RUN conda install -y -c conda-forge "ffmpeg=6" && conda clean -afy

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
