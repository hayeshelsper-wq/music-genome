"""
MusicGen generation service — the generative half of the Genome Studio.

A tiny FastAPI server that wraps Meta's MusicGen (via 🤗 Transformers) and turns a
text prompt — assembled by the web app from an artist/track's measured DNA — into
a short audio clip. Mirrors the flamingo service: its own CUDA image, baked-in
weights, deployed to a private Cloud Run L4 GPU and called with an IAM token.

The web app then runs the generated clip back through the existing /upload
analysis (DSP features + CLAP embedding) and scores how close it landed to the
target — the analyze→generate→verify loop.
"""
import io
import os
import threading

from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel

MODEL_ID = os.environ.get("MUSICGEN_MODEL", "facebook/musicgen-small")
DEVICE = os.environ.get("MUSICGEN_DEVICE", "cuda")
# MusicGen's transformer decodes at ~50 audio tokens per second of output.
TOKENS_PER_SEC = 50
MAX_DURATION = float(os.environ.get("MUSICGEN_MAX_DURATION", "15"))

app = FastAPI(title="Music Genome — MusicGen")

_lock = threading.Lock()
_loaded = False
_model = None
_proc = None
_sr = 32000
_err = None


def _ensure() -> bool:
    """Lazy-load the model once (first request pays the cost; Cloud Run keeps the
    warm instance for subsequent calls)."""
    global _loaded, _model, _proc, _sr, _err
    if _loaded:
        return _model is not None
    with _lock:
        if _loaded:
            return _model is not None
        try:
            import torch
            from transformers import AutoProcessor, MusicgenForConditionalGeneration

            _proc = AutoProcessor.from_pretrained(MODEL_ID)
            model = MusicgenForConditionalGeneration.from_pretrained(MODEL_ID)
            dev = DEVICE if (DEVICE != "cuda" or torch.cuda.is_available()) else "cpu"
            _model = model.to(dev)
            _sr = _model.config.audio_encoder.sampling_rate
        except Exception as e:  # noqa: BLE001
            _err = f"{type(e).__name__}: {str(e)[:300]}"
            _model = None
        finally:
            _loaded = True
    return _model is not None


@app.get("/health")
def health():
    return {"ok": True, "service": "musicgen", "model": MODEL_ID, "loaded": _loaded, "error": _err}


class GenerateReq(BaseModel):
    prompt: str
    duration_sec: float = 10.0
    guidance_scale: float = 3.0
    seed: int | None = None


@app.post("/generate")
def generate(req: GenerateReq):
    if not _ensure():
        return Response(
            content=f'{{"error":"model failed to load: {_err}"}}',
            media_type="application/json",
            status_code=503,
        )
    import torch
    import soundfile as sf

    dur = max(2.0, min(MAX_DURATION, float(req.duration_sec or 10)))
    max_new_tokens = int(dur * TOKENS_PER_SEC)
    dev = next(_model.parameters()).device

    if req.seed is not None:
        torch.manual_seed(int(req.seed))

    inputs = _proc(text=[req.prompt], padding=True, return_tensors="pt").to(dev)
    with torch.no_grad():
        audio = _model.generate(
            **inputs,
            do_sample=True,
            guidance_scale=float(req.guidance_scale),
            max_new_tokens=max_new_tokens,
        )
    wav = audio[0, 0].cpu().numpy()

    buf = io.BytesIO()
    sf.write(buf, wav, _sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="audio/wav",
        headers={"X-Sample-Rate": str(_sr), "X-Duration-Sec": f"{dur:.1f}"},
    )
