"""
Demucs stem separation + per-stem analysis.

This is the *right* home for Demucs (not lyrics): split the preview into
vocals / drums / bass / other, which unlocks a solo/mute player, melody
extraction from the isolated vocal (pyin works on a monophonic stem where it
fails on a full mix), and an isolated drum groove. Runs on Apple-GPU (MPS) in
~8s for a 30s clip, CPU fallback otherwise. Stems are written to a temp dir and
served as static files for the browser to play in sync.
"""
import hashlib
import os
import tempfile
import warnings

import librosa
import numpy as np
import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model

warnings.filterwarnings("ignore")

STEM_DIR = os.path.join(tempfile.gettempdir(), "mg_stems")
os.makedirs(STEM_DIR, exist_ok=True)
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

_model = None


def _get_model():
    global _model
    if _model is None:
        _model = get_model("htdemucs")
    return _model


def key_for(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()[:16]


def separate(audio_path: str):
    """Return {stem_name: stereo np.ndarray (2,N)} and the sample rate."""
    y, sr = librosa.load(audio_path, sr=44100, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    wav = torch.tensor(y, dtype=torch.float32)
    model = _get_model()
    ref = wav.mean(0)
    w = (wav - ref.mean()) / (ref.std() + 1e-8)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    try:
        sources = apply_model(model, w[None], device=device, progress=False, split=True, overlap=0.1)[0]
    except Exception:
        sources = apply_model(model, w[None], device="cpu", progress=False, split=True, overlap=0.1)[0]
    sources = sources * (ref.std() + 1e-8) + ref.mean()
    return {name: src.cpu().numpy() for name, src in zip(model.sources, sources)}, sr


def save_stems(stems: dict, sr: int, key: str) -> dict:
    d = os.path.join(STEM_DIR, key)
    os.makedirs(d, exist_ok=True)
    urls = {}
    for name, arr in stems.items():
        sf.write(os.path.join(d, f"{name}.wav"), arr.T, sr)
        urls[name] = f"/stemfiles/{key}/{name}.wav"
    return urls


def vocal_melody(vocal: np.ndarray, sr: int) -> dict:
    """Pitch contour of the isolated vocal — pyin is reliable here (monophonic)."""
    mono = vocal.mean(0)
    f0, _, _ = librosa.pyin(mono, sr=sr, fmin=80, fmax=1000, frame_length=2048)
    idx = np.linspace(0, len(f0) - 1, 90).astype(int)
    contour = []
    for i in idx:
        v = f0[i]
        contour.append(round(float(v), 1) if (v == v and v > 0) else None)
    notes: dict = {}
    for hz in f0[~np.isnan(f0)]:
        if hz > 0:
            n = NOTES[int(round(12 * np.log2(hz / 440) + 69)) % 12]
            notes[n] = notes.get(n, 0) + 1
    top = [n for n, _ in sorted(notes.items(), key=lambda x: -x[1])[:5]]
    voiced = float(np.mean(~np.isnan(f0)))
    return {"contour": contour, "topNotes": top, "voicedFraction": round(voiced, 2)}


def drum_groove(drums: np.ndarray, sr: int) -> dict:
    mono = drums.mean(0)
    tempo, _ = librosa.beat.beat_track(y=mono, sr=sr)
    onset_env = librosa.onset.onset_strength(y=mono, sr=sr)
    onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, units="time")
    dur = len(mono) / sr
    return {
        "tempo": round(float(np.atleast_1d(tempo)[0])),
        "hitsPerSec": round(len(onsets) / dur, 1),
        "onsets": [round(float(t), 2) for t in onsets[:160]],
    }
