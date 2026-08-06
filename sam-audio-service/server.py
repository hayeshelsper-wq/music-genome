"""Music Genome — SAM Audio promptable extraction service.

Text-prompted source separation ("isolate the tambourine") on an L4 GPU.
Mirrors musicgen-service/server.py: lazy load behind a lock, /health with
{ok, loaded, error}, private Cloud Run behind IAM.

POST /separate {audio_url|audio_b64, text, spans?: [[s,e]], return_residual?}
  -> {target_wav_b64, residual_wav_b64?, sr}
GET /health -> {ok, loaded, error}
"""
import base64
import io
import os
import threading
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

MODEL_ID = os.environ.get("SAM_AUDIO_MODEL", "facebook/sam-audio-base")
DEVICE = os.environ.get("SAM_AUDIO_DEVICE", "cuda")
MAX_INPUT_SEC = float(os.environ.get("SAM_AUDIO_MAX_SEC", "60"))

app = FastAPI(title="Music Genome — SAM Audio")

_lock = threading.Lock()
_loaded = False
_model = None
_proc = None
_sr = 48000  # upstream: facebookresearch/sam-audio@bb4c699 sam_audio/processor.py — audio_sampling_rate = 48_000
_err: Optional[str] = None


def _ensure() -> bool:
    global _loaded, _model, _proc, _sr, _err
    if _loaded:
        return _model is not None
    with _lock:
        if _loaded:
            return _model is not None
        try:
            import torch  # noqa: F401
            # upstream: facebookresearch/sam-audio@bb4c699 README — SAMAudio /
            # SAMAudioProcessor from_pretrained + model.separate(batch).
            from sam_audio import SAMAudio, SAMAudioProcessor

            # upstream: sam_audio/model/base.py — extra kwargs override config
            # keys. Nulling the rankers skips the judge LLM + ImageBind stacks
            # (~5GB downloads + RAM) which are only used when
            # reranking_candidates > 1; we always pass 1.
            _model = SAMAudio.from_pretrained(
                MODEL_ID, visual_ranker=None, text_ranker=None
            ).eval()
            dev = DEVICE if (DEVICE != "cuda" or torch.cuda.is_available()) else "cpu"
            _model = _model.to(dev)
            _proc = SAMAudioProcessor.from_pretrained(MODEL_ID)
            _sr = int(getattr(_proc, "audio_sampling_rate", 48000))
        except Exception as e:  # noqa: BLE001
            import traceback

            traceback.print_exc()  # full detail to logs; _err stays short
            _err = f"{type(e).__name__}: {str(e)[:300]}"
            _model = None
        finally:
            _loaded = True
    return _model is not None


@app.get("/health")
def health(load: int = 0):
    # ?load=1 kicks the lazy load in a background thread so a cold model starts
    # warming without blocking the probe (the web's 202-warming UX polls this).
    if load and not _loaded:
        threading.Thread(target=_ensure, daemon=True).start()
    return {"ok": True, "service": "sam-audio", "model": MODEL_ID, "loaded": _loaded, "error": _err}


class SeparateReq(BaseModel):
    audio_url: Optional[str] = None
    audio_b64: Optional[str] = None
    text: str
    spans: Optional[list] = None  # [[start_s, end_s], ...]
    return_residual: bool = True


def _fetch_audio(req: SeparateReq) -> bytes:
    if req.audio_b64:
        return base64.b64decode(req.audio_b64)
    url = req.audio_url or ""
    if url.startswith("gs://"):
        from google.cloud import storage

        bucket_name, _, blob_path = url[5:].partition("/")
        client = storage.Client()
        return client.bucket(bucket_name).blob(blob_path).download_as_bytes()
    if url.startswith("http"):
        import urllib.request

        r = urllib.request.Request(url, headers={"User-Agent": "MusicGenome/1.0"})
        return urllib.request.urlopen(r, timeout=30).read()
    raise ValueError("audio_url or audio_b64 required")


def _wav_b64(wav, sr: int) -> str:
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    return base64.b64encode(buf.getvalue()).decode()


@app.post("/separate")
def separate(req: SeparateReq):
    if not _ensure():
        return JSONResponse({"error": f"model failed to load: {_err}"}, status_code=503)
    import librosa
    import numpy as np
    import tempfile
    import torch

    raw = _fetch_audio(req)
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        with open(path, "wb") as f:
            f.write(raw)
        # Resample to the model's expected rate, mono, cap length.
        y, _ = librosa.load(path, sr=_sr, mono=True, duration=MAX_INPUT_SEC)
        if not len(y):
            return JSONResponse({"error": "empty audio"}, status_code=400)

        # upstream: facebookresearch/sam-audio@bb4c699 sam_audio/processor.py —
        # __call__(descriptions, audios, anchors=None, ...); anchors are
        # [(token, start_s, end_s)] with token "+"/"-"/"<null>".
        anchors = None
        if req.spans:
            anchors = [[("+", float(s), float(e)) for s, e in req.spans]]
        kwargs = {
            "descriptions": [req.text.lower().strip()],
            "audios": [torch.from_numpy(y)],
        }
        if anchors:
            kwargs["anchors"] = anchors
        batch = _proc(**kwargs)
        dev = next(_model.parameters()).device
        batch = batch.to(dev)
        with torch.no_grad():
            # upstream: facebookresearch/sam-audio@bb4c699 README —
            # model.separate(batch, predict_spans=..., reranking_candidates=...)
            result = _model.separate(batch, predict_spans=bool(req.spans), reranking_candidates=1)

        target = result.target[0].detach().cpu().numpy().astype(np.float32).squeeze()
        out = {"target_wav_b64": _wav_b64(target, _sr), "sr": _sr}
        if req.return_residual and getattr(result, "residual", None) is not None:
            residual = result.residual[0].detach().cpu().numpy().astype(np.float32).squeeze()
            out["residual_wav_b64"] = _wav_b64(residual, _sr)
        return out
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)[:300]}, status_code=500)
    finally:
        if os.path.exists(path):
            os.unlink(path)
