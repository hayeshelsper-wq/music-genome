# LoRA trainer (Cloud Run Job, L4). ACE-Step repo + training extras + GCP clients.
# upstream: ace-step/ACE-Step-1.5@6d467e4
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 git && rm -rf /var/lib/apt/lists/*

# nano-vllm is vendored; torch pin needs the cu128 index (see acestep-service).
RUN git clone https://github.com/ace-step/ACE-Step-1.5 /opt/acestep && \
    cd /opt/acestep && git checkout 6d467e4b5081ccb0abf1ec1bf4fdf9051a2d34b0 && \
    pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cu128 \
      ./acestep/third_parts/nano-vllm . && \
    pip install --no-cache-dir google-cloud-firestore google-cloud-storage

ENV HF_HOME=/models
ENV ACESTEP_CHECKPOINT_DIR=/models/acestep
RUN python -c "from huggingface_hub import snapshot_download; \
    snapshot_download('ACE-Step/Ace-Step1.5', local_dir='/models/acestep')"

COPY train.py .

CMD ["python", "train.py"]
