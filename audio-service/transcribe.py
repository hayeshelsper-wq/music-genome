"""Symbolic layer: audio → note events → composition DNA → MIDI.

Two transcription paths:
  - transcribe_polyphonic: Spotify basic-pitch on a stem or full mix. We prefer
    the ONNX runtime (basic-pitch[onnx]) in the Docker image — the TF dependency
    roughly doubles the image; the installed 0.4.0 wheel auto-picks whichever
    runtime is present (TF → CoreML → TFLite → ONNX).
  - transcribe_monophonic: librosa.pyin for single-voice sources (hums).

Note shape everywhere: {"p": midi_pitch, "s": start_s, "e": end_s, "v": velocity}.
All DNA vectors are plain float lists (JSON-safe, cosine-comparable).
"""
import base64
import io

import numpy as np

MIN_NOTE_SEC = 0.08
MERGE_GAP_SEC = 0.03
MIN_VELOCITY = 20


def _postfilter(notes: list[dict]) -> list[dict]:
    """Merge same-pitch notes separated by tiny gaps, then drop blips."""
    notes = sorted(notes, key=lambda n: (n["s"], n["p"]))
    merged: list[dict] = []
    for n in notes:
        prev = merged[-1] if merged else None
        if (
            prev
            and prev["p"] == n["p"]
            and n["s"] - prev["e"] < MERGE_GAP_SEC
        ):
            prev["e"] = max(prev["e"], n["e"])
            prev["v"] = max(prev["v"], n["v"])
            continue
        merged.append(dict(n))
    return [
        {"p": int(n["p"]), "s": round(float(n["s"]), 3), "e": round(float(n["e"]), 3), "v": int(n["v"])}
        for n in merged
        if (n["e"] - n["s"]) >= MIN_NOTE_SEC and n["v"] >= MIN_VELOCITY
    ]


def transcribe_polyphonic(audio_path: str) -> dict:
    """basic-pitch on a stem or mix → filtered note list."""
    from basic_pitch.inference import predict  # heavy — lazy

    # upstream: spotify/basic-pitch@fa5997a basic_pitch/inference.py — predict()
    # returns (model_output, pretty_midi.PrettyMIDI, note_events).
    _model_output, midi_data, _note_events = predict(audio_path)
    notes = []
    for inst in midi_data.instruments:
        for n in inst.notes:
            notes.append(
                {"p": int(n.pitch), "s": float(n.start), "e": float(n.end), "v": int(n.velocity)}
            )
    return {"notes": _postfilter(notes), "source": "basic-pitch"}


def transcribe_monophonic(audio_path: str, fmin: float = 80.0, fmax: float = 800.0) -> dict:
    """pyin for hums / single voices: voiced runs → notes. A new note starts when
    the median-filtered pitch moves ≥0.6 semitone or voicing breaks >60ms."""
    import librosa
    from scipy.signal import medfilt

    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    f0, _voiced_flag, _voiced_prob = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr)
    times = librosa.times_like(f0, sr=sr)

    midi = np.full_like(f0, np.nan)
    voiced = ~np.isnan(f0)
    midi[voiced] = librosa.hz_to_midi(f0[voiced])
    # Median filter over the voiced contour only (k=5) to kill octave blips.
    smooth = midi.copy()
    if voiced.sum() >= 5:
        smooth[voiced] = medfilt(midi[voiced], kernel_size=5)

    notes: list[dict] = []
    run: list[float] = []
    run_start = 0.0
    last_t = None

    def close_run(end_t: float) -> None:
        if not run:
            return
        pitch = int(round(float(np.median(run))))
        notes.append({"p": pitch, "s": run_start, "e": end_t, "v": 90})

    for i, t in enumerate(times):
        if not voiced[i] or np.isnan(smooth[i]):
            continue
        p = float(smooth[i])
        if run and last_t is not None and (t - last_t) > 0.06:
            close_run(last_t)
            run = []
        if run and abs(p - float(np.median(run))) >= 0.6:
            close_run(t)
            run = []
        if not run:
            run_start = float(t)
        run.append(p)
        last_t = float(t)
    if run and last_t is not None:
        close_run(last_t)

    return {"notes": _postfilter(notes), "source": "pyin"}


def melodic_dna(notes: list[dict], key_root: int = 0) -> dict:
    """Composition fingerprint: interval histogram (±12 → 25 bins), key-relative
    pitch-class distribution, inter-onset rhythm histogram (0–2s, 16 bins),
    density and range. All lists L1-normalized floats."""
    if not notes:
        return {
            "interval_hist": [0.0] * 25,
            "pitch_class_dist": [0.0] * 12,
            "rhythm_hist": [0.0] * 16,
            "note_density_per_s": 0.0,
            "range_semitones": 0,
        }
    ordered = sorted(notes, key=lambda n: n["s"])
    pitches = [n["p"] for n in ordered]
    starts = [n["s"] for n in ordered]

    interval_hist = np.zeros(25)
    for a, b in zip(pitches, pitches[1:]):
        iv = int(np.clip(b - a, -12, 12))
        interval_hist[iv + 12] += 1
    if interval_hist.sum():
        interval_hist /= interval_hist.sum()

    pc = np.zeros(12)
    for n in ordered:
        pc[(n["p"] - key_root) % 12] += max(0.01, n["e"] - n["s"])
    if pc.sum():
        pc /= pc.sum()

    rhythm = np.zeros(16)
    for a, b in zip(starts, starts[1:]):
        ioi = min(max(b - a, 0.0), 2.0)
        rhythm[min(15, int(ioi / 2.0 * 16))] += 1
    if rhythm.sum():
        rhythm /= rhythm.sum()

    span = max(0.25, (max(n["e"] for n in ordered) - min(starts)))
    return {
        "interval_hist": [round(float(x), 5) for x in interval_hist],
        "pitch_class_dist": [round(float(x), 5) for x in pc],
        "rhythm_hist": [round(float(x), 5) for x in rhythm],
        "note_density_per_s": round(len(ordered) / span, 3),
        "range_semitones": int(max(pitches) - min(pitches)),
    }


def quantize_notes(notes: list[dict], bpm: float) -> list[dict]:
    """Snap note starts to the nearest 1/8 grid (duration preserved). Returns a
    NEW list — raw notes are never overwritten."""
    if not notes or not bpm or bpm <= 0:
        return []
    grid = 60.0 / bpm / 2.0  # eighth note
    out = []
    for n in notes:
        dur = n["e"] - n["s"]
        s = round(round(n["s"] / grid) * grid, 3)
        out.append({"p": n["p"], "s": s, "e": round(s + dur, 3), "v": n["v"]})
    return out


def to_midi_b64(notes: list[dict], bpm: float | None) -> str:
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(initial_tempo=float(bpm) if bpm else 120.0)
    inst = pretty_midi.Instrument(program=0)  # acoustic grand
    for n in notes:
        if n["e"] <= n["s"]:
            continue
        inst.notes.append(
            pretty_midi.Note(
                velocity=int(n["v"]), pitch=int(n["p"]), start=float(n["s"]), end=float(n["e"])
            )
        )
    pm.instruments.append(inst)
    buf = io.BytesIO()
    pm.write(buf)
    return base64.b64encode(buf.getvalue()).decode()
