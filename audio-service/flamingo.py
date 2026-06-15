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
import time
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

# Prefer the local Audio Flamingo 3 sidecar (runs on this Mac's GPU) over NVIDIA's
# public HF Space, which is unreliable. The sidecar reads a local wav path — same
# machine — so we just hand it the transcoded file.
LOCAL = os.environ.get("MUSIC_FLAMINGO_LOCAL", "0") not in ("0", "false", "False", "")
LOCAL_URL = os.environ.get(
    "MUSIC_FLAMINGO_LOCAL_URL", "http://127.0.0.1:8077/describe"
)

PROMPT = (
    "Act as a professional music analyst. Listen to the ENTIRE track from start "
    "to finish and describe it in full detail: genre, mood, key, tempo, chords "
    "and harmony, instrumentation, production style, timbre, and song structure. "
    "Be especially precise about two things: (1) VOCALS — state clearly whether a "
    "human lead vocal is present and, if so, describe it; do NOT assume the track "
    "is instrumental. (2) EVERY instrument you hear, including any that appear only "
    "briefly in the intro or in the outro/ending — for example a string instrument "
    "such as a cello that enters only at the very end. Explicitly describe how the "
    "ending/outro differs from the rest of the arrangement."
)


def describe(audio_path: str, prompt: str = PROMPT, timeout: float | None = None) -> dict:
    if not ENABLED:
        return {"description": "", "disabled": True}
    wav = None
    try:
        # Flamingo wants wav/mp3/flac; previews are m4a, so transcode once and
        # hand the wav to whichever backend is configured.
        y, sr = librosa.load(audio_path, sr=16000, mono=True)
        fd, wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        sf.write(wav, y, sr)

        if LOCAL:
            return _describe_local(wav, prompt, timeout)
        return _describe_space(wav, prompt, timeout)
    except Exception as e:  # noqa: BLE001 — best-effort
        return {"description": "", "error": str(e)[:200]}
    finally:
        if wav and os.path.exists(wav):
            os.unlink(wav)


def is_warm() -> bool:
    """Quick probe: is the GPU sidecar up with the model loaded? Lets the upload
    pick sync-Flamingo (warm) vs fast-return + async backfill (cold). A cold
    sidecar won't answer within the short timeout → treated as cold (and the
    probe itself nudges Cloud Run to start warming it)."""
    if not (ENABLED and LOCAL):
        return False
    try:
        url = LOCAL_URL.replace("/describe", "/health")
        token = _gcp_id_token(url)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        with httpx.Client(timeout=httpx.Timeout(6.0)) as c:
            r = c.get(url, headers=headers)
        return r.status_code == 200 and bool(r.json().get("loaded"))
    except Exception:  # noqa: BLE001
        return False


def _gcp_id_token(target_url: str) -> str | None:
    """Google-signed ID token for calling a private Cloud Run service. No-ops off
    GCP (no metadata server), so localhost calls go out unauthenticated."""
    try:
        from urllib.parse import urlsplit

        u = urlsplit(target_url)
        audience = f"{u.scheme}://{u.netloc}"
        r = httpx.get(
            "http://metadata.google.internal/computeMetadata/v1/instance/"
            f"service-accounts/default/identity?audience={audience}",
            headers={"Metadata-Flavor": "Google"},
            timeout=2.0,
        )
        return r.text.strip() if r.status_code == 200 else None
    except Exception:  # noqa: BLE001
        return None


def _describe_local(wav: str, prompt: str, timeout: float | None = None) -> dict:
    """Call the Audio Flamingo 3 sidecar by UPLOADING the wav. Works whether the
    sidecar is on localhost (dev) or a separate Cloud Run GPU service (prod) —
    no shared filesystem assumed."""
    # Retry while the GPU is cold-starting (503 / connection refused) until the
    # deadline, so a cold-GPU backfill waits the ~2min warm-up out instead of
    # failing on the first 503.
    deadline = time.monotonic() + float(timeout or TIMEOUT)
    token = _gcp_id_token(LOCAL_URL)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    last_err = "flamingo unavailable"
    while time.monotonic() < deadline:
        remaining = max(15.0, deadline - time.monotonic())
        try:
            with httpx.Client(timeout=httpx.Timeout(remaining)) as c:
                with open(wav, "rb") as f:
                    r = c.post(
                        LOCAL_URL,
                        files={"file": ("clip.wav", f, "audio/wav")},
                        data={"prompt": prompt},
                        headers=headers,
                    )
            if r.status_code in (503, 429):  # cold-starting — wait and retry
                last_err = f"flamingo {r.status_code} (warming up)"
                time.sleep(8)
                continue
            r.raise_for_status()
            return r.json()
        except (httpx.ConnectError, httpx.ConnectTimeout):
            last_err = "flamingo connecting (warming up)"
            time.sleep(8)
            continue
        except httpx.ReadTimeout:
            return {"description": "", "error": "flamingo timed out"}
        except Exception as e:  # noqa: BLE001
            return {"description": "", "error": f"flamingo: {str(e)[:200]}"}
    return {"description": "", "error": last_err}


def _describe_space(wav: str, prompt: str, timeout: float | None = None) -> dict:
    """Call NVIDIA's public HF Space via the raw gradio queue API (fallback)."""
    with httpx.Client(timeout=httpx.Timeout(timeout or TIMEOUT)) as c:
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
        if ev == "error":
            return {"description": "", "error": "flamingo space returned an error (likely GPU quota/cold start)"}
        return {"description": "", "error": f"no completion (last event: {ev or 'none'})"}
    out = json.loads(final)
    text = out[0] if isinstance(out, list) else out
    text = (text or "").replace("✅ Using audio file", "").strip()
    return {"description": text}
