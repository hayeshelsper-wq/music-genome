"""
NVIDIA Music Flamingo client.

Music Flamingo (Audio Flamingo 3, 8B) is a *music-specialized* audio-language
model — it actually listens and produces a theory-aware description (genre, key,
chords, instrumentation, production, structure). It needs an A100/H100, so it
can't run locally; instead we call NVIDIA's public HF Space, which serves the
model on their GPU, via the raw gradio queue API (no gradio_client — its version
lags the Space's gradio).

This is *informed AI opinion*, not ground truth (it'll confidently mis-identify a
song), so the pipeline pairs it with librosa's measured numbers and Genius's real
metadata, then lets Claude weigh all three. Best-effort: any failure returns an
empty description and the rest of the analysis carries on.

Override MUSIC_FLAMINGO_URL to point at a self-hosted deployment (Modal / HF
Inference Endpoint) for a reliable, non-rate-limited path.
"""
import json
import os
import tempfile
import warnings

import httpx
import librosa
import soundfile as sf

warnings.filterwarnings("ignore")

BASE = os.environ.get(
    "MUSIC_FLAMINGO_URL", "https://nvidia-music-flamingo.hf.space/gradio_api"
)
TIMEOUT = float(os.environ.get("MUSIC_FLAMINGO_TIMEOUT", "300"))
ENABLED = os.environ.get("MUSIC_FLAMINGO_ENABLED", "1") not in ("0", "false", "False")

PROMPT = (
    "Act as a professional music analyst. Describe this track in full detail: "
    "genre, mood, key, tempo, chords and harmony, instrumentation, production "
    "style, timbre, vocal characteristics, lyrical themes, and song structure."
)


def describe(audio_path: str, prompt: str = PROMPT) -> dict:
    if not ENABLED:
        return {"description": "", "disabled": True}
    wav = None
    try:
        # Music Flamingo wants wav/mp3/flac; previews are m4a, so transcode.
        y, sr = librosa.load(audio_path, sr=16000, mono=True)
        fd, wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        sf.write(wav, y, sr)

        with httpx.Client(timeout=httpx.Timeout(TIMEOUT)) as c:
            with open(wav, "rb") as f:
                up = c.post(f"{BASE}/upload", files={"files": ("clip.wav", f, "audio/wav")})
            up.raise_for_status()
            server_path = up.json()[0]

            payload = {
                "data": [
                    {"path": server_path, "meta": {"_type": "gradio.FileData"}},
                    "",  # YouTube URL (unused)
                    prompt,
                ]
            }
            sub = c.post(f"{BASE}/call/infer", json=payload)
            sub.raise_for_status()
            event_id = sub.json().get("event_id")
            if not event_id:
                return {"description": "", "error": "no event_id"}

            final, ev = None, None
            with c.stream("GET", f"{BASE}/call/infer/{event_id}") as r:
                for line in r.iter_lines():
                    if not line:
                        continue
                    if line.startswith("event:"):
                        ev = line.split(":", 1)[1].strip()
                    elif line.startswith("data:") and ev == "complete":
                        final = line.split(":", 1)[1].strip()

        if not final:
            return {"description": "", "error": "no completion"}
        out = json.loads(final)
        text = out[0] if isinstance(out, list) else out
        text = (text or "").replace("✅ Using audio file", "").strip()
        return {"description": text}
    except Exception as e:  # noqa: BLE001 — best-effort
        return {"description": "", "error": str(e)[:200]}
    finally:
        if wav and os.path.exists(wav):
            os.unlink(wav)
