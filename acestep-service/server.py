"""Music Genome — ACE-Step 1.5 song generation service.

Full songs (tags + lyrics, up to MAX_DURATION seconds) with optional LoRA
"voices" trained on the user's own uploads. Mirrors musicgen-service/server.py:
lazy load behind a lock, /health, WAV + X-Sample-Rate responses, private Cloud
Run L4 behind IAM.

POST /generate {prompt, lyrics?, duration_sec=60, lora_gcs?, seed?} → WAV
GET  /health → {ok, loaded, error, variant, lora_loaded}
"""
import io
import os
import shutil
import threading
from collections import OrderedDict
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

# L4 (24GB): base/turbo DiT + a small LM fit resident; xl-* documented but off.
VARIANT = os.environ.get("ACESTEP_VARIANT", "base")
CONFIG_PATH = os.environ.get("ACESTEP_CONFIG", "acestep-v15-turbo")
LM_MODEL = os.environ.get("ACESTEP_LM_MODEL", "acestep-5Hz-lm-0.6B")
DEVICE = os.environ.get("ACESTEP_DEVICE", "cuda")
MAX_DURATION = float(os.environ.get("MAX_DURATION", "120"))
CHECKPOINT_DIR = os.environ.get("ACESTEP_CHECKPOINT_DIR", "/models/acestep")
LORA_CACHE_DIR = os.environ.get("LORA_CACHE_DIR", "/tmp/loras")
LORA_CACHE_MAX = 2

app = FastAPI(title="Music Genome — ACE-Step")

_lock = threading.Lock()
_loaded = False
_dit = None
_llm = None
_err: Optional[str] = None
_current_lora: Optional[str] = None  # gcs path currently loaded
_lora_cache: "OrderedDict[str, str]" = OrderedDict()  # gcs path -> local dir


def _ensure() -> bool:
    global _loaded, _dit, _llm, _err
    if _loaded:
        return _dit is not None
    with _lock:
        if _loaded:
            return _dit is not None
        try:
            # upstream: ace-step/ACE-Step-1.5@6d467e4 docs/en/INFERENCE.md —
            # AceStepHandler (DiT) + LLMHandler (5Hz LM) + generate_music().
            from acestep.handler import AceStepHandler
            from acestep.llm_inference import LLMHandler

            _dit = AceStepHandler()
            _dit.initialize_service(
                project_root=CHECKPOINT_DIR, config_path=CONFIG_PATH, device=DEVICE
            )
            _llm = LLMHandler()
            _llm.initialize(
                checkpoint_dir=CHECKPOINT_DIR, lm_model_path=LM_MODEL, device=DEVICE
            )
        except Exception as e:  # noqa: BLE001
            _err = f"{type(e).__name__}: {str(e)[:300]}"
            _dit = None
        finally:
            _loaded = True
    return _dit is not None


def _fetch_lora(gcs_path: str) -> str:
    """Download a gs:// adapter dir into an LRU-cached local dir (max 2)."""
    if gcs_path in _lora_cache:
        _lora_cache.move_to_end(gcs_path)
        return _lora_cache[gcs_path]
    from google.cloud import storage

    bucket_name, _, prefix = gcs_path[5:].partition("/")
    local_dir = os.path.join(LORA_CACHE_DIR, prefix.replace("/", "_"))
    os.makedirs(local_dir, exist_ok=True)
    client = storage.Client()
    blobs = list(client.bucket(bucket_name).list_blobs(prefix=prefix))
    if not blobs:
        raise ValueError(f"no adapter files at {gcs_path}")
    for b in blobs:
        name = os.path.basename(b.name)
        if name:
            b.download_to_filename(os.path.join(local_dir, name))
    _lora_cache[gcs_path] = local_dir
    while len(_lora_cache) > LORA_CACHE_MAX:
        _evicted_path, evicted_dir = _lora_cache.popitem(last=False)
        shutil.rmtree(evicted_dir, ignore_errors=True)
    return local_dir


def _apply_lora(gcs_path: Optional[str]) -> None:
    """Load/unload so the requested adapter (or none) is active."""
    global _current_lora
    if gcs_path == _current_lora:
        return
    # upstream: ace-step/ACE-Step-1.5@6d467e4 acestep/api/http/lora_routes.py —
    # handler.load_lora(path) / handler.unload_lora() / set_use_lora(bool).
    if gcs_path:
        local_dir = _fetch_lora(gcs_path)
        _dit.load_lora(local_dir)
        _dit.set_use_lora(True)
    else:
        _dit.unload_lora()
        _dit.set_use_lora(False)
    _current_lora = gcs_path


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "acestep",
        "loaded": _loaded,
        "error": _err,
        "variant": VARIANT,
        "lora_loaded": _current_lora,
    }


class GenerateReq(BaseModel):
    prompt: str  # comma-separated style tags (ACE-Step "caption")
    lyrics: Optional[str] = None
    duration_sec: float = 60.0
    lora_gcs: Optional[str] = None
    seed: Optional[int] = None


@app.post("/generate")
def generate(req: GenerateReq):
    if not _ensure():
        return JSONResponse({"error": f"model failed to load: {_err}"}, status_code=503)
    import numpy as np
    import soundfile as sf

    try:
        with _lock:  # one generation at a time (concurrency=1 on Cloud Run too)
            _apply_lora(req.lora_gcs or None)

            dur = max(10.0, min(MAX_DURATION, float(req.duration_sec or 60)))
            # upstream: ace-step/ACE-Step-1.5@6d467e4 docs/en/INFERENCE.md —
            # GenerationParams(caption≤512, lyrics≤4096, duration 10–600,
            # seed (-1 random), ...) → generate_music(dit, llm, params, config,
            # save_dir) → GenerationResult(tensor [ch, samples], sample_rate).
            from acestep.inference import GenerationParams, GenerationConfig, generate_music

            params = GenerationParams(
                caption=req.prompt[:512],
                lyrics=(req.lyrics or "")[:4096],
                duration=dur,
                seed=int(req.seed) if req.seed is not None else -1,
            )
            config = GenerationConfig()
            result = generate_music(_dit, _llm, params, config, save_dir=None)

        tensor = result.tensor
        sr = int(getattr(result, "sample_rate", 48000))
        wav = tensor.detach().cpu().numpy() if hasattr(tensor, "detach") else np.asarray(tensor)
        if wav.ndim == 2:  # [channels, samples] -> [samples, channels]
            wav = wav.T
        buf = io.BytesIO()
        sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
        buf.seek(0)
        return Response(
            content=buf.read(),
            media_type="audio/wav",
            headers={"X-Sample-Rate": str(sr), "X-Duration-Sec": f"{dur:.1f}"},
        )
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"{type(e).__name__}: {str(e)[:300]}"}, status_code=500)
