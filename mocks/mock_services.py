# Mock GPU services — a CPU-only stand-in for every GPU backend (musicgen,
# musicgen-melody, acestep, sam-audio, magenta-rt) so the whole app can be
# exercised end-to-end on a laptop. Deliberately dumb: sine waves in, sine
# waves out — but shaped so the REAL analysis pipeline can observe differences
# (a "bright" prompt adds a 4kHz component; the WS session's tone tracks the
# crossfade weight; /separate band-splits the actual input audio).
#
# Run: uvicorn mock_services:app --port 9090   (from mocks/)
# Deps: fastapi, uvicorn, numpy, soundfile — no ML.

import asyncio
import base64
import io
import json
import time
from typing import Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

app = FastAPI(title="Music Genome — mock GPU services")

SR = 32000

# Request log so tests can assert what the app actually sent (bodies are
# truncated: audio/melody b64 fields are replaced with their byte length).
REQUEST_LOG: list[dict] = []


def _log(endpoint: str, body: dict) -> None:
    slim = {}
    for k, v in body.items():
        if isinstance(v, str) and len(v) > 256:
            slim[k] = f"<{len(v)} chars>"
        else:
            slim[k] = v
    REQUEST_LOG.append({"t": time.time(), "endpoint": endpoint, "body": slim})
    del REQUEST_LOG[:-200]


@app.get("/health")
def health():
    return {"ok": True, "loaded": True, "error": None, "service": "mock", "warm": True}


@app.get("/log")
def log():
    return {"requests": REQUEST_LOG}


@app.post("/log/clear")
def log_clear():
    REQUEST_LOG.clear()
    return {"ok": True}


class GenerateReq(BaseModel):
    # Union of musicgen / musicgen-melody / acestep request bodies.
    prompt: str = ""
    duration_sec: float = 10.0
    guidance_scale: float = 3.0
    seed: Optional[int] = None
    lyrics: Optional[str] = None
    lora_gcs: Optional[str] = None
    melody_wav_b64: Optional[str] = None


def _wav_bytes(wav: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return buf.read()


@app.post("/generate")
def generate(req: GenerateReq):
    _log("/generate", req.model_dump())
    dur = max(1.0, min(float(req.duration_sec or 10.0), 180.0))
    t = np.linspace(0, dur, int(SR * dur), endpoint=False)
    wav = 0.4 * np.sin(2 * np.pi * 440 * t) + 0.3 * np.sin(2 * np.pi * 220 * t)
    if "bright" in (req.prompt or "").lower():
        # Audible + measurable brightness bump for the optimizer-loop test.
        wav = wav + 0.25 * np.sin(2 * np.pi * 4000 * t)
    # A quiet click track so tempo estimation has something to chew on.
    beat = np.zeros_like(wav)
    step = int(SR * 0.5)  # 120 BPM
    for i in range(0, len(beat), step):
        beat[i : i + 200] += 0.5 * np.hanning(min(200, len(beat) - i))
    wav = np.clip(wav + beat, -0.97, 0.97)
    return Response(
        content=_wav_bytes(wav.astype(np.float32), SR),
        media_type="audio/wav",
        headers={"X-Sample-Rate": str(SR), "X-Duration-Sec": f"{dur:.1f}"},
    )


class SeparateReq(BaseModel):
    audio_url: Optional[str] = None
    audio_b64: Optional[str] = None
    text: str = ""
    spans: Optional[list] = None
    return_residual: bool = True


@app.post("/separate")
def separate(req: SeparateReq):
    _log("/separate", req.model_dump())
    if req.audio_b64:
        raw = base64.b64decode(req.audio_b64)
        wav, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
    elif req.audio_url:
        import urllib.request

        with urllib.request.urlopen(req.audio_url, timeout=30) as r:
            wav, sr = sf.read(io.BytesIO(r.read()), dtype="float32", always_2d=False)
    else:
        return JSONResponse({"error": "audio_url or audio_b64 required"}, status_code=400)
    if wav.ndim > 1:
        wav = wav.mean(axis=1)

    # FFT band-pass (500–2000 Hz) as the "target", band-stop as the residual —
    # crude, but audibly different so the extraction UX can be exercised.
    spec = np.fft.rfft(wav)
    freqs = np.fft.rfftfreq(len(wav), 1 / sr)
    band = (freqs >= 500) & (freqs <= 2000)
    target = np.fft.irfft(spec * band, n=len(wav)).astype(np.float32)
    residual = np.fft.irfft(spec * ~band, n=len(wav)).astype(np.float32)

    out = {
        "target_wav_b64": base64.b64encode(_wav_bytes(target, sr)).decode(),
        "sr": sr,
    }
    if req.return_residual:
        out["residual_wav_b64"] = base64.b64encode(_wav_bytes(residual, sr)).decode()
    return out


# ---- mock Magenta-RT crossfade session -------------------------------------
# Protocol (matches mrt-service): client sends {type:"init", a, b, weight},
# then {type:"weight", value} at any rate, then {type:"stop"}. Server sends one
# {type:"meta"} text frame, then binary s16le 48kHz stereo PCM chunks whose
# tone frequency interpolates 220→880 Hz with the latest weight — an audible
# proof the slider reaches the generator. ?slow=1 stalls between chunks so the
# client's buffering indicator can be QA'd.

WS_SR = 48000
CHUNK_SEC = 0.5


@app.websocket("/session")
async def session(ws: WebSocket):
    await ws.accept()
    slow = ws.query_params.get("slow") == "1"
    weight = 0.5
    running = True

    try:
        init_raw = await ws.receive_text()
        init = json.loads(init_raw)
        weight = float(init.get("weight", 0.5))
    except Exception:
        await ws.close()
        return
    _log("/session:init", {k: init.get(k) for k in ("weight",)} | {"a": "…", "b": "…"})

    await ws.send_text(
        json.dumps({"type": "meta", "sr": WS_SR, "channels": 2, "chunkSec": CHUNK_SEC})
    )

    async def reader():
        nonlocal weight, running
        try:
            while running:
                msg = json.loads(await ws.receive_text())
                if msg.get("type") == "weight":
                    weight = max(0.0, min(1.0, float(msg.get("value", 0.5))))
                elif msg.get("type") == "stop":
                    running = False
        except (WebSocketDisconnect, Exception):
            running = False

    read_task = asyncio.create_task(reader())
    phase = 0.0
    started = time.time()
    try:
        while running and (time.time() - started) < 15 * 60:
            freq = 220.0 + (880.0 - 220.0) * weight
            n = int(WS_SR * CHUNK_SEC)
            t = np.arange(n) / WS_SR
            tone = 0.4 * np.sin(2 * np.pi * freq * t + phase)
            phase = (phase + 2 * np.pi * freq * CHUNK_SEC) % (2 * np.pi)
            stereo = np.repeat((tone * 32767).astype(np.int16), 2)
            await ws.send_bytes(stereo.tobytes())
            await asyncio.sleep(CHUNK_SEC * (3.0 if slow else 0.85))
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        running = False
        read_task.cancel()
        try:
            await ws.close(code=1000, reason="session_cap")
        except Exception:
            pass
