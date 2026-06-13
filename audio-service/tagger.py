"""
Discriminative music tagger — Essentia's Discogs-EffNet embedding + MTG-Jamendo
classification heads (instrument / genre / mood-theme) plus the voice/instrumental
head. Unlike the generative audio-LLM (Flamingo), these are supervised classifiers
trained on labelled music, so they give a TRUSTWORTHY answer to "what instruments
are present" and "is there a vocal" — the things Flamingo hallucinates.

Runs on CPU in the audio-service (no GPU, no cold-start). One embedding pass feeds
all four heads. Best-effort: any failure returns {} so the rest of the analysis
still runs.

Models are baked into the image under MUSIC_TAGGER_DIR (see Dockerfile). Source:
https://essentia.upf.edu/models/ (Discogs-EffNet + classification-heads).
"""
import json
import os
import threading

MODEL_DIR = os.environ.get("MUSIC_TAGGER_DIR", "/app/tagger_models")
EFFNET = os.path.join(MODEL_DIR, "discogs-effnet-bs64-1.pb")

# head name → (graph file stem, output node). The MTG-Jamendo multi-label heads
# emit `model/Sigmoid`; the 2-class voice/instrumental head emits `model/Softmax`
# (per each model's metadata json). TensorflowPredict2D defaults to model/Sigmoid,
# so the Softmax head MUST be specified explicitly or configuring it throws.
HEADS = {
    "instruments": ("mtg_jamendo_instrument-discogs-effnet-1", "model/Sigmoid"),
    "genres": ("mtg_jamendo_genre-discogs-effnet-1", "model/Sigmoid"),
    "moods": ("mtg_jamendo_moodtheme-discogs-effnet-1", "model/Sigmoid"),
    "voice": ("voice_instrumental-discogs-effnet-1", "model/Softmax"),
}

# how many tags to surface per head, and the min activation to include
TOPK = {"instruments": 6, "genres": 4, "moods": 4}
MIN_PROB = {"instruments": 0.10, "genres": 0.06, "moods": 0.04}

# prettify the compressed MTG label vocabulary
_PRETTY = {
    "acousticguitar": "acoustic guitar",
    "electricguitar": "electric guitar",
    "classicalguitar": "classical guitar",
    "acousticbassguitar": "acoustic bass guitar",
    "electricpiano": "electric piano",
    "drummachine": "drum machine",
    "pipeorgan": "pipe organ",
    "doublebass": "double bass",
    "voice": "vocals",
}

_lock = threading.Lock()
_loaded = False
_embed = None
_models: dict = {}
_labels: dict = {}
_load_error = None


def _pretty(label: str) -> str:
    return _PRETTY.get(label, label.replace("_", " "))


def _ensure_loaded() -> bool:
    global _loaded, _embed, _models, _labels, _load_error
    if _loaded:
        return _embed is not None
    with _lock:
        if _loaded:
            return _embed is not None
        try:
            from essentia.standard import (  # noqa: PLC0415 — heavy import, lazy
                TensorflowPredict2D,
                TensorflowPredictEffnetDiscogs,
            )

            _embed = TensorflowPredictEffnetDiscogs(
                graphFilename=EFFNET, output="PartitionedCall:1"
            )
            for key, (stem, out) in HEADS.items():
                _models[key] = TensorflowPredict2D(
                    graphFilename=os.path.join(MODEL_DIR, f"{stem}.pb"), output=out
                )
                with open(os.path.join(MODEL_DIR, f"{stem}.json")) as f:
                    _labels[key] = json.load(f)["classes"]
        except Exception as e:  # noqa: BLE001 — best-effort; tagging is a bonus
            _load_error = f"{type(e).__name__}: {str(e)[:200]}"
            _embed = None
        finally:
            _loaded = True
    return _embed is not None


def tag(audio_path: str) -> dict:
    """Return discriminative tags for a track. Best-effort — {} on any failure."""
    if not _ensure_loaded():
        return {"error": _load_error} if _load_error else {}
    try:
        import numpy as np
        from essentia.standard import MonoLoader  # noqa: PLC0415

        # discogs-effnet wants 16kHz mono. (Older essentia builds' MonoLoader has
        # no resampleQuality arg, so don't pass it.)
        audio = MonoLoader(filename=audio_path, sampleRate=16000)()
        embeddings = _embed(audio)

        def _scored(key: str):
            preds = _models[key](embeddings)  # (n_patches, n_classes)
            mean = np.asarray(preds).mean(axis=0)
            labels = _labels[key]
            order = mean.argsort()[::-1]
            out = []
            for i in order[: TOPK[key]]:
                p = float(mean[i])
                if p < MIN_PROB[key]:
                    break
                out.append({"label": _pretty(labels[i]), "prob": round(p, 3)})
            return out

        # voice/instrumental — a dedicated 2-class head; report the vocal verdict
        v_pred = np.asarray(_models["voice"](embeddings)).mean(axis=0)
        v_labels = _labels["voice"]  # e.g. ["instrumental", "voice"]
        vi = {lab: float(v_pred[i]) for i, lab in enumerate(v_labels)}
        vocal_p = vi.get("voice", 0.0)
        instr_p = vi.get("instrumental", 0.0)

        return {
            "instruments": _scored("instruments"),
            "genres": _scored("genres"),
            "moods": _scored("moods"),
            "voice": {"vocal": vocal_p >= instr_p, "prob": round(vocal_p, 3)},
        }
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {str(e)[:200]}"}
