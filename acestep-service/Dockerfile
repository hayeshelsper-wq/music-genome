# ACE-Step 1.5 song generation — CUDA runtime + upstream repo + baked weights.
# upstream: ace-step/ACE-Step-1.5@6d467e4 (MIT; weights ungated on HF).
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 git && rm -rf /var/lib/apt/lists/*

# Upstream is uv-based with no PyPI package; install the pinned repo directly.
RUN pip install --no-cache-dir \
    "git+https://github.com/ace-step/ACE-Step-1.5@6d467e4b5081ccb0abf1ec1bf4fdf9051a2d34b0" \
    fastapi "uvicorn[standard]" soundfile google-cloud-storage

# Bake the base DiT + smallest 5Hz LM (L4-friendly resident pair). The bundle
# repo ACE-Step/Ace-Step1.5 carries the config-addressable checkpoints.
ENV HF_HOME=/models
ENV ACESTEP_CHECKPOINT_DIR=/models/acestep
RUN python -c "from huggingface_hub import snapshot_download; \
    snapshot_download('ACE-Step/Ace-Step1.5', local_dir='/models/acestep'); \
    snapshot_download('ACE-Step/acestep-5Hz-lm-0.6B', local_dir='/models/acestep/acestep-5Hz-lm-0.6B')"

COPY server.py .

ENV PORT=8080
ENV ACESTEP_DEVICE=cuda
ENV ACESTEP_VARIANT=base
ENV MAX_DURATION=120
CMD uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080}
