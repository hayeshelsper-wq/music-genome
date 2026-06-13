"""
CLAP embeddings (LAION music-CLAP via transformers) — joint text+audio space.
Powers "Sonic Twins" (audio→audio similarity) and "search by sound" (text→audio).
Audio is embedded once per track at analysis time; text is embedded per query.
512-dim, L2-normalized so cosine == dot product. CPU; best-effort (None on failure).
"""
import os
import threading

# laion/clap-htsat-unfused — the canonical CLAP with a healthy text tower for
# text→audio retrieval. (larger_clap_music's text tower is degenerate in
# transformers — returns ~identical vectors for any query.)
MODEL_ID = os.environ.get("CLAP_MODEL", "laion/clap-htsat-unfused")
CLAP_SR = 48000  # CLAP expects 48kHz mono

_lock = threading.Lock()
_loaded = False
_model = None
_proc = None
_err: str | None = None


def _ensure() -> bool:
    global _loaded, _model, _proc, _err
    if _loaded:
        return _model is not None
    with _lock:
        if _loaded:
            return _model is not None
        try:
            from transformers import ClapModel, ClapProcessor

            _model = ClapModel.from_pretrained(MODEL_ID).eval()
            _proc = ClapProcessor.from_pretrained(MODEL_ID)
        except Exception as e:  # noqa: BLE001 — best-effort; embeddings are a bonus
            _err = f"{type(e).__name__}: {str(e)[:200]}"
            _model = None
        finally:
            _loaded = True
    return _model is not None


def _norm(vec) -> list:
    import numpy as np

    a = np.asarray(vec, dtype="float32")
    n = float(np.linalg.norm(a))
    return (a / n).tolist() if n > 0 else a.tolist()


def embed_audio(path: str) -> list | None:
    if not _ensure():
        return None
    try:
        import librosa
        import torch

        audio, _ = librosa.load(path, sr=CLAP_SR, mono=True)
        inputs = _proc(audios=audio, sampling_rate=CLAP_SR, return_tensors="pt")
        with torch.no_grad():
            feat = _model.get_audio_features(**inputs)
        return _norm(feat[0].cpu().numpy())
    except Exception:  # noqa: BLE001
        return None


def embed_text(text: str) -> list | None:
    if not _ensure() or not text:
        return None
    try:
        import torch

        inputs = _proc(text=[text], return_tensors="pt", padding=True)
        with torch.no_grad():
            feat = _model.get_text_features(**inputs)
        return _norm(feat[0].cpu().numpy())
    except Exception:  # noqa: BLE001
        return None


def status() -> dict:
    return {"loaded": _model is not None, "error": _err, "model": MODEL_ID}
