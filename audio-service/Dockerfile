# ---- audio-service (CPU DSP: librosa / demucs / faster-whisper + Essentia
#      discriminative taggers) → Cloud Run ----
# Build context is the audio-service/ directory. Python 3.10 because
# essentia-tensorflow only ships Linux wheels up to cp310.
FROM python:3.10-slim

WORKDIR /app

# ffmpeg → decode m4a previews; libsndfile → soundfile I/O; curl → fetch models;
# rubberband-cli → high-quality time-stretch/pitch-shift for the Mashup Lab.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libsndfile1 curl rubberband-cli \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ---- bake the discriminative tagger models (Essentia Discogs-EffNet embedding +
#      MTG-Jamendo instrument/genre/mood heads + voice/instrumental). ~100MB. ----
ENV MUSIC_TAGGER_DIR=/app/tagger_models
RUN mkdir -p "$MUSIC_TAGGER_DIR" && cd "$MUSIC_TAGGER_DIR" && \
    B=https://essentia.upf.edu/models && \
    curl -fsSLO "$B/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb" && \
    for h in mtg_jamendo_instrument mtg_jamendo_genre mtg_jamendo_moodtheme voice_instrumental; do \
      curl -fsSLO "$B/classification-heads/$h/$h-discogs-effnet-1.pb" && \
      curl -fsSLO "$B/classification-heads/$h/$h-discogs-effnet-1.json" ; \
    done && ls -la "$MUSIC_TAGGER_DIR"

# ---- bake the LAION music-CLAP weights (text+audio embeddings, ~1.7GB) into the
#      HF cache so it loads offline. (faster-whisper still downloads at runtime, so
#      do NOT set HF_HUB_OFFLINE globally.) ----
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('laion/clap-htsat-unfused')"

COPY . .

ENV PORT=8080
# AF3 runs as its OWN Cloud Run GPU service; point this at it (set at deploy time).
ENV MUSIC_FLAMINGO_LOCAL=1
# MUSIC_FLAMINGO_LOCAL_URL=https://<flamingo-service-url>/describe

EXPOSE 8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
