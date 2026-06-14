"""
Mashup Lab — combine stems from two tracks into one playable clip.

Demucs-separate both tracks, take chosen stems from each (default: vocals from A,
instrumental bed from B), then CONFORM the A stems to B: time-stretch to B's tempo
and pitch-shift to B's key (both measured here), so an acapella sits in the bed's
groove and key. Returns a single mixed wav. librosa's phase-vocoder stretch/shift
is approximate but dependency-free (no rubberband binary needed).
"""
import io

import librosa
import numpy as np
import soundfile as sf

import stems as stemlib

# Krumhansl-Kessler key profiles.
_MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _tempo_key(mono: np.ndarray, sr: int):
    tempo, _ = librosa.beat.beat_track(y=mono, sr=sr)
    tempo = float(np.atleast_1d(tempo)[0]) or 120.0
    chroma = librosa.feature.chroma_cqt(y=mono, sr=sr).mean(axis=1)
    best = (-1e9, 0, "major")
    for r in range(12):
        cr = np.roll(chroma, -r)
        for prof, mode in ((_MAJ, "major"), (_MIN, "minor")):
            c = float(np.corrcoef(cr, prof)[0, 1])
            if c > best[0]:
                best = (c, r, mode)
    return round(tempo), best[1], best[2]


def _nearest_semitones(a_root: int, b_root: int) -> int:
    d = (b_root - a_root) % 12
    return d - 12 if d > 6 else d


def _conform(stereo: np.ndarray, sr: int, rate: float, n_steps: int) -> np.ndarray:
    """Time-stretch by `rate` (>1 = faster) then pitch-shift by n_steps, per channel."""
    chans = []
    for ch in stereo:
        y = ch.astype(np.float32)
        if abs(rate - 1.0) > 0.02:
            y = librosa.effects.time_stretch(y, rate=rate)
        if n_steps != 0:
            y = librosa.effects.pitch_shift(y, sr=sr, n_steps=n_steps)
        chans.append(y)
    n = min(len(c) for c in chans)
    return np.stack([c[:n] for c in chans])


def _sum_stems(sources: dict, names: list) -> np.ndarray:
    picked = [sources[n] for n in names if n in sources]
    if not picked:
        raise ValueError("no matching stems")
    return np.sum(picked, axis=0)  # (2, N)


def mashup(a_path: str, b_path: str, a_stems: list, b_stems: list):
    sa, sr = stemlib.separate(a_path)
    sb, _ = stemlib.separate(b_path)

    a_mix = np.sum(list(sa.values()), axis=0).mean(0)
    b_mix = np.sum(list(sb.values()), axis=0).mean(0)
    a_tempo, a_root, a_mode = _tempo_key(a_mix, sr)
    b_tempo, b_root, b_mode = _tempo_key(b_mix, sr)

    rate = float(np.clip(b_tempo / max(a_tempo, 1), 0.5, 2.0))
    shift = _nearest_semitones(a_root, b_root)

    a_sel = _conform(_sum_stems(sa, a_stems), sr, rate, shift)
    b_sel = _sum_stems(sb, b_stems)

    n = min(a_sel.shape[1], b_sel.shape[1])
    mix = a_sel[:, :n] * 1.15 + b_sel[:, :n] * 0.95  # nudge the acapella forward
    peak = float(np.max(np.abs(mix))) or 1.0
    mix = (mix / peak) * 0.97

    buf = io.BytesIO()
    sf.write(buf, mix.T, sr, format="WAV", subtype="PCM_16")
    meta = {
        "a_tempo": a_tempo, "b_tempo": b_tempo,
        "a_key": f"{NOTES[a_root]} {a_mode}", "b_key": f"{NOTES[b_root]} {b_mode}",
        "stretch_rate": round(rate, 3), "semitone_shift": shift,
        "duration_sec": round(n / sr, 1),
    }
    return buf.getvalue(), meta
