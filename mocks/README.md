# Mock GPU harness

CPU-only FastAPI stand-in for every GPU service (musicgen, musicgen-melody,
acestep, sam-audio, magenta-rt). Lets the whole app run end-to-end on a laptop:
generation returns sine-wave WAVs the **real** analysis pipeline can measure
(a prompt containing `bright` adds a 4kHz component, so the optimizer loop can
observe a genuine brightness change), `/separate` band-splits the actual input,
and the `/session` WebSocket streams a tone whose pitch follows the crossfade
weight.

## Run

```bash
cd mocks
python3 -m venv .venv && .venv/bin/pip install fastapi "uvicorn[standard]" numpy soundfile pydantic
.venv/bin/uvicorn mock_services:app --port 9090
```

The real `audio-service` runs locally on CPU and is part of every e2e check:

```bash
cd audio-service && uvicorn main:app --port 8000
```

Then point the web app at the mocks:

```bash
MUSICGEN_URL=http://127.0.0.1:9090 \
ACESTEP_URL=http://127.0.0.1:9090 \
SAM_AUDIO_URL=http://127.0.0.1:9090 \
MRT_WS_URL=ws://127.0.0.1:9090/session \
npm run dev
```

## Endpoints

| Endpoint | Mocks | Behavior |
|---|---|---|
| `POST /generate` | musicgen / melody / acestep | WAV of `duration_sec` s, 440+220Hz sine @32kHz, `X-Sample-Rate` header; `bright` in prompt → +4kHz component; 120 BPM click bed |
| `POST /separate` | sam-audio | `{target_wav_b64, residual_wav_b64, sr}` — band-passed vs band-stopped input |
| `WS /session` | magenta-rt | `{type:"meta"}` then s16le 48kHz stereo chunks; tone frequency = 220→880Hz by latest `weight`; `?slow=1` stalls chunks to exercise the buffering UI |
| `GET /health` | all | `{ok, loaded:true, warm:true}` |
| `GET /log` / `POST /log/clear` | — | request log for test assertions (large b64 fields logged as byte length) |
