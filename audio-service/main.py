"""
Music Genome — Audio Analysis micro-service.

The post-Spotify, post-"can an LLM hear?" reality: Ollama models can't ingest
audio (gemma does images, not sound), so the *measurement* of a track has to be
real DSP. This FastAPI service takes a 30s preview URL and returns:

  - labeled musical features (tempo, key, brightness, dynamics, harmony…) — the
    labels matter so the downstream LLM interprets "0.72" as "wide" not "low";
  - a Whisper transcription of the sung words (best-effort; music confuses ASR);
  - a chromagram PNG (the harmonic content over time) for the UI.

The Next.js app layers Genius metadata + an Ollama/gemma "producer's breakdown"
on top of this. Run:  uvicorn main:app --port 8000
"""
import base64
import io
import os
import tempfile
import urllib.request
import warnings
from typing import Optional

import librosa
import numpy as np
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import stems as stemlib

warnings.filterwarnings("ignore")
app = FastAPI(title="Music Genome — Audio Analysis")
# The browser plays stem files directly from this service (port 8000).
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)
app.mount("/stemfiles", StaticFiles(directory=stemlib.STEM_DIR), name="stemfiles")

import flamingo

NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_cache: dict = {}
_flamingo_cache: dict = {}
_whisper = None


def whisper_model():
    """Lazy-load Whisper once; first call downloads the ~140MB base model."""
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel

        _whisper = WhisperModel("base", device="cpu", compute_type="int8")
    return _whisper


class AnalyzeReq(BaseModel):
    previewUrl: str
    title: Optional[str] = None
    artist: Optional[str] = None
    transcribe: bool = True


def _download(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "MusicGenome/0.1"})
    data = urllib.request.urlopen(req, timeout=25).read()
    fd, path = tempfile.mkstemp(suffix=".m4a")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


def _label(value: float, bins: list, labels: list) -> str:
    for edge, lab in zip(bins, labels):
        if value <= edge:
            return lab
    return labels[-1]


def analyze_audio(path: str) -> dict:
    y, sr = librosa.load(path, sr=22050, mono=True)
    dur = len(y) / sr

    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(np.atleast_1d(tempo)[0])

    # key via Krumhansl-Schmuckler correlation
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    KS_MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    KS_MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

    def best(profile):
        cc = [np.corrcoef(np.roll(profile, i), chroma_mean)[0, 1] for i in range(12)]
        j = int(np.argmax(cc))
        return NOTES[j], float(cc[j])

    mk, ck = best(KS_MAJ)
    nk, cn = best(KS_MIN)
    key, mode, conf = (mk, "major", ck) if ck >= cn else (nk, "minor", cn)

    # harmonic palette: which pitch classes are most present
    top = np.argsort(chroma_mean)[::-1][:4]
    harmonic_emphasis = [NOTES[i] for i in top]

    cent = float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
    harm, perc = librosa.effects.hpss(y)
    hp_ratio = float(np.sum(harm ** 2) / (np.sum(perc ** 2) + 1e-9))
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_rate = float(len(librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)) / dur)

    rms = librosa.feature.rms(y=y)[0]
    arc = [round(float(x), 3) for x in np.interp(np.linspace(0, len(rms) - 1, 12), np.arange(len(rms)), rms)]
    quiet, loud = float(rms.min()), float(rms.max())
    dyn = round((loud - quiet) / (loud + 1e-9), 2)
    # does the clip build, fade, or hold steady?
    half = len(arc) // 2
    delta = np.mean(arc[half:]) - np.mean(arc[:half])
    shape = "builds" if delta > 0.03 else "winds down" if delta < -0.03 else "holds steady"

    return {
        "duration_sec": round(dur, 1),
        "tempo_bpm": round(tempo),
        "tempo_feel": _label(tempo, [75, 100, 120, 140], ["slow", "mid-tempo", "upbeat", "driving", "fast"]),
        "key": f"{key} {mode}",
        "key_confidence": round(conf, 2),
        "harmonic_emphasis": harmonic_emphasis,
        "brightness_hz": round(cent),
        "brightness": _label(cent, [1200, 2000, 3000], ["dark", "warm", "mid-bright", "bright"]),
        "harmonic_vs_percussive": round(hp_ratio, 1),
        "texture": _label(hp_ratio, [1.0, 3.0], ["percussive / drum-driven", "balanced", "tonal / sustained"]),
        "onset_rate_per_sec": round(onset_rate, 1),
        "density": _label(onset_rate, [2.0, 4.0], ["sparse", "moderate", "busy"]),
        "dynamic_range": dyn,
        "dynamics": _label(dyn, [0.4, 0.7], ["compressed / consistent", "moderate", "wide / dynamic"]),
        "energy_arc": arc,
        "energy_shape": shape,
    }


def transcribe(path: str) -> dict:
    try:
        model = whisper_model()
        # NB: vad_filter classifies sung-over-instruments as "no speech" and drops
        # everything, so it's off. Even so, ASR mishears music heavily — this is a
        # rough "what the model heard", not authoritative lyrics (Genius is that).
        segments, info = model.transcribe(path, beam_size=1, vad_filter=False)
        lines = [s.text.strip() for s in segments if s.text.strip()]
        return {"text": " ".join(lines), "lines": lines, "language": info.language}
    except Exception as e:  # noqa: BLE001 — ASR is best-effort
        return {"text": "", "lines": [], "error": str(e)[:160]}


def chromagram_png(path: str) -> Optional[str]:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import librosa.display

        y, sr = librosa.load(path, sr=22050, mono=True)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        fig, ax = plt.subplots(figsize=(6, 2.2))
        librosa.display.specshow(chroma, y_axis="chroma", x_axis="time", sr=sr, ax=ax, cmap="magma")
        ax.set(title="")
        fig.patch.set_facecolor("#07070c")
        ax.set_facecolor("#07070c")
        for t in ax.get_xticklabels() + ax.get_yticklabels():
            t.set_color("#9a9ab0")
            t.set_fontsize(7)
        fig.tight_layout(pad=0.3)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=110, facecolor="#07070c")
        plt.close(fig)
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:  # noqa: BLE001 — image is a nicety
        return None


@app.get("/health")
def health():
    return {"ok": True, "service": "audio-analysis", "flamingo": flamingo.ENABLED}


_stems_cache: dict = {}


def transcribe_timed(path: str) -> list:
    """Whisper on the ISOLATED vocal stem — far more accurate than on the mix —
    with segment timestamps, for karaoke-style line highlighting."""
    try:
        model = whisper_model()
        segments, _ = model.transcribe(path, beam_size=1, vad_filter=False)
        return [
            {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
            for s in segments
            if s.text.strip()
        ]
    except Exception:  # noqa: BLE001
        return []


@app.post("/stems")
def separate_stems(req: AnalyzeReq):
    """Demucs stem separation + per-stem analysis + karaoke timing."""
    key = stemlib.key_for(req.previewUrl)
    if key in _stems_cache and os.path.exists(os.path.join(stemlib.STEM_DIR, key, "vocals.wav")):
        return _stems_cache[key]
    path = None
    try:
        path = _download(req.previewUrl)
        sources, sr = stemlib.separate(path)
        urls = stemlib.save_stems(sources, sr, key)
        result = {
            "stems": urls,
            "melody": stemlib.vocal_melody(sources["vocals"], sr),
            "groove": stemlib.drum_groove(sources["drums"], sr),
            "karaoke": transcribe_timed(os.path.join(stemlib.STEM_DIR, key, "vocals.wav")),
        }
        _stems_cache[key] = result
        return result
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200], "stems": {}}
    finally:
        if path and os.path.exists(path):
            os.unlink(path)


@app.post("/flamingo")
def flamingo_describe(req: AnalyzeReq):
    """Music Flamingo's musician-level read (slow, GPU-on-a-Space, best-effort)."""
    if req.previewUrl in _flamingo_cache:
        return _flamingo_cache[req.previewUrl]
    path = None
    try:
        path = _download(req.previewUrl)
        result = flamingo.describe(path)
        if result.get("description"):
            _flamingo_cache[req.previewUrl] = result
        return result
    except Exception as e:  # noqa: BLE001
        return {"description": "", "error": str(e)[:200]}
    finally:
        if path and os.path.exists(path):
            os.unlink(path)


@app.post("/analyze")
def analyze(req: AnalyzeReq):
    if req.previewUrl in _cache:
        return _cache[req.previewUrl]
    path = None
    try:
        path = _download(req.previewUrl)
        result = {
            "features": analyze_audio(path),
            "lyrics": transcribe(path) if req.transcribe else {"text": "", "lines": []},
            "chromagram": chromagram_png(path),
        }
        _cache[req.previewUrl] = result
        return result
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200], "features": None, "lyrics": {"text": "", "lines": []}}
    finally:
        if path and os.path.exists(path):
            os.unlink(path)
