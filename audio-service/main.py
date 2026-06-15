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
from fastapi import FastAPI, File, UploadFile
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
import tagger
import clap

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
    # For the X-ray hybrid: when requireWarm is set, /flamingo returns immediately
    # (cold=True) if the GPU isn't already warm, so the caller can degrade to an
    # async backfill instead of blocking on a cold start. timeout overrides the
    # per-call Flamingo deadline (the backfill uses a long one to warm the GPU).
    requireWarm: bool = False
    timeout: Optional[float] = None


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


def _name_progression(romans: list) -> Optional[str]:
    """Recognize a few famous chord loops in the Roman-numeral sequence."""
    s = "-".join(romans)
    patterns = [
        ("I-V-vi-IV", "I–V–vi–IV — the 'Axis' pop progression"),
        ("vi-IV-I-V", "vi–IV–I–V — the 'Axis' progression"),
        ("I-vi-IV-V", "I–vi–IV–V — the doo-wop / '50s progression"),
        ("ii-V-I", "ii–V–I — the jazz cadence"),
        ("I-V-vi-iii-IV", "the Pachelbel / Canon progression"),
        ("I-IV-V", "I–IV–V — the three-chord rock & blues backbone"),
        ("i-♭VII-♭VI-♭VII", "i–♭VII–♭VI–♭VII — the Andalusian-flavored minor loop"),
        ("i-♭VI-♭VII", "i–♭VI–♭VII — the epic minor lift"),
        ("i-iv-v", "i–iv–v — the natural-minor backbone"),
    ]
    for pat, label in patterns:
        if pat in s:
            return label
    return None


def _detect_chords(chroma: np.ndarray, beats, key_root: int):
    """Rough triad detection: beat-synchronize the chroma, match each beat against
    24 major/minor triad templates, collapse repeats, and read out the chord names
    plus Roman numerals relative to the detected key. Best-effort — clean on simple
    pop, noisier on dense mixes."""
    try:
        csync = librosa.util.sync(chroma, beats, aggregate=np.median) if np.size(beats) >= 2 else chroma
    except Exception:  # noqa: BLE001
        csync = chroma

    maj = np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0], float)  # root, M3, P5
    minr = np.array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0], float)  # root, m3, P5
    templates, meta = [], []
    for r in range(12):
        templates.append(np.roll(maj, r)); meta.append((r, "maj"))
        templates.append(np.roll(minr, r)); meta.append((r, "min"))
    T = np.array(templates)
    Tn = T / np.linalg.norm(T, axis=1, keepdims=True)

    seq = []
    for col in csync.T:
        v = col.astype(float)
        n = np.linalg.norm(v)
        if n < 1e-6:
            continue
        scores = Tn @ (v / n)
        b = int(np.argmax(scores))
        if scores[b] < 0.5:  # too ambiguous to call
            continue
        seq.append(meta[b])

    collapsed = []
    for c in seq:
        if not collapsed or collapsed[-1] != c:
            collapsed.append(c)
    if not collapsed:
        return [], [], None

    ROMAN = ["I", "♭II", "II", "♭III", "III", "IV", "♯IV", "V", "♭VI", "VI", "♭VII", "VII"]
    names, romans = [], []
    for root, q in collapsed[:16]:
        names.append(NOTES[root] + ("" if q == "maj" else "m"))
        r = ROMAN[(root - key_root) % 12]
        romans.append(r if q == "maj" else r.lower())
    return names, romans, _name_progression(romans)


def analyze_audio(path: str) -> dict:
    y, sr = librosa.load(path, sr=22050, mono=True)
    dur = len(y) / sr

    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
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

    chords, chords_roman, progression = _detect_chords(chroma, beats, NOTES.index(key))

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
        "chords": chords,
        "chords_roman": chords_roman,
        "progression": progression,
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


def _section_label(i: int, n: int, r: float) -> str:
    if i == 0 and r < 0.55:
        return "Intro"
    if i == n - 1 and r < 0.55:
        return "Outro"
    if r > 0.85:
        return "Peak / hook"
    if r > 0.6:
        return "Full section"
    return "Breakdown / sparse"


def segment_song(path: str) -> list:
    """Structure/energy map of a full track: boundaries from beat-synced timbre +
    harmony (agglomerative), each section labeled by relative energy and position.
    Approximate — an energy map, not ground-truth verse/chorus labels."""
    try:
        y, sr = librosa.load(path, sr=22050, mono=True)
        dur = len(y) / sr
        if dur < 20:
            return []
        _, beats = librosa.beat.beat_track(y=y, sr=sr)
        if np.size(beats) < 8:
            return []
        mfcc = librosa.util.sync(librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13), beats)
        chroma = librosa.util.sync(librosa.feature.chroma_cqt(y=y, sr=sr), beats)
        feat = np.vstack(
            [librosa.util.normalize(mfcc, axis=1), librosa.util.normalize(chroma, axis=1)]
        )
        k = int(np.clip(round(dur / 24), 3, 8))
        bound_beats = librosa.segment.agglomerative(feat, k)
        times = librosa.frames_to_time(beats[bound_beats], sr=sr).tolist()
        times = sorted(set([0.0] + [round(t, 1) for t in times] + [round(dur, 1)]))

        rms = librosa.feature.rms(y=y)[0]
        rms_t = librosa.times_like(rms, sr=sr)
        raw = []
        for i in range(len(times) - 1):
            t0, t1 = times[i], times[i + 1]
            if t1 - t0 < 3:
                continue
            mask = (rms_t >= t0) & (rms_t < t1)
            raw.append((t0, t1, float(np.mean(rms[mask])) if mask.any() else 0.0))
        if not raw:
            return []
        emax = max(e for _, _, e in raw) or 1.0
        n = len(raw)
        return [
            {
                "start": round(t0, 1),
                "end": round(t1, 1),
                "intensity": round(e / emax, 2),
                "label": _section_label(i, n, e / emax),
            }
            for i, (t0, t1, e) in enumerate(raw)
        ]
    except Exception:  # noqa: BLE001 — structure is best-effort
        return []


# AF-Next (the deployed `audio-flamingo-next-captioner-hf`) handles long-form
# audio — up to 30 min, processed internally in 30s windows. So we feed it the
# WHOLE track (from the start, intro through outro), not just the loudest 30s,
# which used to miss anything outside the hook (e.g. a quiet cello outro). Capped
# at 5 min to bound L4 GPU memory/latency.
MAX_FLAMINGO_SEC = float(os.environ.get("MUSIC_FLAMINGO_MAX_SEC", "300"))


def _flamingo_for_upload(path: str, sections: list, timeout: float = 75.0) -> str:
    """Run Flamingo on the full uploaded track (capped at MAX_FLAMINGO_SEC) so it
    hears the whole arrangement, not a single 30s window. `sections` is unused now
    that we send the entire song. Returns "" on a cold GPU / timeout / error so the
    upload still completes (graceful, like the X-ray)."""
    try:
        import soundfile as sf

        y, sr = librosa.load(path, sr=16000, mono=True, duration=MAX_FLAMINGO_SEC)
        fd, clip = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            sf.write(clip, y, sr)
            return flamingo.describe(clip, timeout=timeout).get("description") or ""
        finally:
            if os.path.exists(clip):
                os.unlink(clip)
    except Exception:  # noqa: BLE001 — Flamingo is best-effort
        return ""


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


class EmbedTextReq(BaseModel):
    text: str


@app.post("/embed-text")
def embed_text(req: EmbedTextReq):
    """CLAP text embedding for 'search by sound' queries (same 512-dim space as
    the per-track audio embeddings)."""
    return {"embedding": clap.embed_text(req.text)}


@app.post("/embed-clip")
async def embed_clip(file: UploadFile = File(...)):
    """CLAP audio embedding for an uploaded clip — used to backfill vectors for
    tracks analyzed before CLAP existed."""
    suffix = os.path.splitext(file.filename or "clip")[1] or ".mp3"
    fd, tmp = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(await file.read())
        return {"embedding": clap.embed_audio(tmp)}
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


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


class MashupReq(BaseModel):
    aUrl: str
    bUrl: str
    aStems: list = ["vocals"]
    bStems: list = ["drums", "bass", "other"]


@app.post("/mashup")
def make_mashup(req: MashupReq):
    """Mashup Lab: Demucs-separate both tracks, conform A's stems to B's tempo+key,
    and return a single mixed clip (base64 wav data URL)."""
    import base64
    import mashup as mashuplib

    a = b = None
    try:
        a = _download(req.aUrl)
        b = _download(req.bUrl)
        wav, meta = mashuplib.mashup(a, b, req.aStems, req.bStems)
        return {"audio": "data:audio/wav;base64," + base64.b64encode(wav).decode(), **meta}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200]}
    finally:
        for p in (a, b):
            if p and os.path.exists(p):
                os.unlink(p)


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
    # Warm-gate: the X-ray's first paint asks for Flamingo only if the GPU is
    # already warm. On a cold GPU, return fast so the web can show the analysis
    # immediately and poll the async backfill (which warms the GPU) instead.
    if req.requireWarm and not flamingo.is_warm():
        return {"description": "", "cold": True}
    path = None
    try:
        path = _download(req.previewUrl)
        result = flamingo.describe(path, timeout=req.timeout)
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
            "tags": tagger.tag(path),  # discriminative instrument/genre/mood/vocal
            "embedding": clap.embed_audio(path),  # CLAP vector for sonic search/twins
        }
        _cache[req.previewUrl] = result
        return result
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200], "features": None, "lyrics": {"text": "", "lines": []}}
    finally:
        if path and os.path.exists(path):
            os.unlink(path)


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    """Analyze a full uploaded track — whole-song features + chromagram + a
    structure/energy map. No 30-second preview ceiling."""
    suffix = os.path.splitext(file.filename or "audio.mp3")[1] or ".mp3"
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(await file.read())
        sections = segment_song(path)
        features = analyze_audio(path)
        chroma = chromagram_png(path)
        # Only run Flamingo synchronously if the GPU is already warm. If it's cold,
        # return "" immediately (don't block the upload for the ~2min warm-up) — the
        # web falls back to the async /flamingo-clip backfill. The probe also nudges
        # the GPU to start warming for that backfill.
        flamingo_text = (
            _flamingo_for_upload(path, sections, timeout=75.0)
            if flamingo.is_warm()
            else ""
        )
        return {
            "features": features,
            "chromagram": chroma,
            "sections": sections,
            "flamingo": flamingo_text,
            "tags": tagger.tag(path),  # discriminative instrument/genre/mood/vocal
            "embedding": clap.embed_audio(path),  # CLAP vector for sonic search/twins
            "filename": file.filename,
        }
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200], "features": None, "sections": []}
    finally:
        if os.path.exists(path):
            os.unlink(path)


@app.post("/flamingo-clip")
async def flamingo_clip(file: UploadFile = File(...)):
    """Async backfill: run Flamingo on a representative window of an uploaded
    track with a LONG timeout, so it waits out a cold-GPU load (~2-3min)."""
    suffix = os.path.splitext(file.filename or "audio.mp3")[1] or ".mp3"
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(await file.read())
        return {"flamingo": _flamingo_for_upload(path, segment_song(path), timeout=320.0)}
    except Exception as e:  # noqa: BLE001
        return {"flamingo": "", "error": str(e)[:200]}
    finally:
        if os.path.exists(path):
            os.unlink(path)
