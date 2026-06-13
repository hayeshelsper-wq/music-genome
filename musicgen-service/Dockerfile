# ---- MusicGen → Cloud Run + NVIDIA L4 GPU ----
# Build context is musicgen-service/. Mirrors Dockerfile.flamingo: a CUDA image
# with the model weights BAKED IN (Cloud Run's writable FS is in-memory, so a
# runtime download would eat RAM and OOM the container — bake to a read-only layer
# instead). The model is public, so no token is needed at build time.
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      "transformers>=4.40,<5" accelerate \
      fastapi "uvicorn[standard]" soundfile scipy pydantic

# ---- model weights: BAKED INTO THE IMAGE ----
ENV HF_HOME=/models
ARG MUSICGEN_MODEL=facebook/musicgen-small
ENV MUSICGEN_MODEL=${MUSICGEN_MODEL}
RUN python -c "import os; from huggingface_hub import snapshot_download; snapshot_download(os.environ['MUSICGEN_MODEL'])"

COPY server.py .

ENV PORT=8080
ENV MUSICGEN_DEVICE=cuda
EXPOSE 8080
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080}"]
