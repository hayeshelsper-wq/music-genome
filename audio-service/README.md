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
