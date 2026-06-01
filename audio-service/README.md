# Audio Analysis service (Song X-Ray)

A small Python/FastAPI sidecar that does the **measurement** the LLMs can't:
real DSP on a track's 30-second preview. The Next.js app (`/api/track/analyze`)
calls this, layers Genius metadata + an LLM "producer breakdown" on top, and
renders the **Song X-Ray** panel when you click a track.

## Why a separate Python service?

The honest finding: **no Ollama model can ingest audio** (gemma does images, not
sound), and even open audio-LLMs (Qwen2-Audio etc.) give *vibes*, not reliable
key/tempo/structure. Extracting those is signal processing — `librosa`'s job.
So: librosa measures, the LLM interprets. This service is the measurement half.

## What it returns

- **Features** (labeled so the LLM can't misread a bare float): tempo + feel,
  key (Krumhansl-Schmuckler) + confidence, harmonic emphasis, texture
  (harmonic/percussive), brightness, rhythmic density, dynamics, and a 12-point
  energy arc with a shape (builds / holds / winds down).
- **Lyrics**: a best-effort Whisper transcription of the preview. NB: ASR
  mishears sung-over-instruments heavily — the Next app prefers Genius for
  accurate lyrics and treats this as a rough "what the model heard".
- **Chromagram**: a PNG of pitch content over time (for the UI).

## Run it

```bash
cd audio-service
pip install -r requirements.txt        # librosa/numpy may already be present
uvicorn main:app --port 8000
```

First `/analyze` call downloads the Whisper `base` model (~140MB) and is slower;
results are cached per preview after that. The Next app expects it at
`http://127.0.0.1:8000` (override with `AUDIO_SERVICE_URL`).

If the service isn't running, the rest of the app is unaffected — the Song X-Ray
panel just shows a "service not running" note.

## Music Flamingo (the "AI listener")

`POST /flamingo {previewUrl}` returns NVIDIA **Music Flamingo**'s musician-level
read of the clip (genre, chords, instrumentation, structure, production). It's an
8B audio-LLM that needs an A100/H100, so it can't run locally — `flamingo.py`
calls NVIDIA's **public HF Space** (which serves it on their GPU) via the raw
gradio queue API. It's *informed AI opinion*, not ground truth, so the Next app
feeds it — alongside librosa's measured numbers and Genius metadata — to a
Grammy-producer-persona LLM that delivers the final critique.

- `MUSIC_FLAMINGO_ENABLED=0` to skip it (critique falls back to librosa-only).
- `MUSIC_FLAMINGO_URL=...` to point at a self-hosted Modal / HF Inference
  Endpoint deployment instead of the public Space (more reliable, not rate-limited).

The public Space is a free demo — fine for a personal project, but it can queue,
rate-limit, or be paused. Results are cached per preview.

## Stem Lab (Demucs source separation)

`POST /stems {previewUrl}` runs **Demucs** (htdemucs) to split the clip into
vocals / drums / bass / other, writes them to a temp dir served at `/stemfiles`,
and returns analysis of the *isolated* stems:

- **Vocal melody** — `librosa.pyin` on the isolated vocal (reliable monophonic
  pitch tracking, which fails on a full mix): contour + dominant notes.
- **Drum groove** — tempo + onset pattern of the isolated drum stem.
- **Karaoke** — Whisper on the isolated vocal for *timing* (the Next app swaps in
  accurate Genius lines for the *text*, since ASR still mishears singing).

Runs on Apple-GPU (MPS) in ~8s for a 30s clip (CPU fallback). The browser plays
the four stem files in sync for solo/mute. First call downloads the htdemucs
model (~80MB).
