"""Music Genome — Magenta RealTime crossfader service.

Streams live-generated audio whose style is a spherical interpolation between
two anchor styles (text tags or reference audio), steered by a weight slider.

WS /session protocol (text JSON in, binary PCM out):
  client→server: {type:"init", a:{text?,audio_b64?}, b:{text?,audio_b64?}, weight}
                 then {type:"weight", value} at any rate, {type:"stop"}.
  server→client: one {type:"meta", sr, channels, chunkSec} text frame, then
                 s16le interleaved stereo PCM binary frames (CHUNK_S seconds).

Weights: google/magenta-realtime-2 (CC-BY 4.0 — attribution shipped in the
repo README and the /crossfade page footer). Code Apache-2.0.
"""
import asyncio
import base64
import io
import json
import os
import threading
import time
from typing import Optional

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

MODEL_SIZE = os.environ.get("MRT_MODEL", "mrt2_base")
CHUNK_S = float(os.environ.get("CHUNK_S", "2.0"))
SESSION_CAP_S = 15 * 60
SR = 48000
CHANNELS = 2

app = FastAPI(title="Music Genome — Magenta RT")

_lock = threading.Lock()
_loaded = False
_system = None
_style = None
_err: Optional[str] = None
_warm = False
# One live session at a time — generation saturates the GPU.
_session_sem = threading.Semaphore(1)

# MusicCoCa runs on TFLite interpreters, which are single-threaded AND
# thread-affine — concurrent (or cross-thread) invokes raise "There is at
# least 1 reference to internal data". EVERY style-model touch (construction,
# warm-up embed, anchor embeds, tokenize) runs on this one worker thread.
from concurrent.futures import ThreadPoolExecutor

_style_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="style")


def _on_style_thread(fn, *args):
    """Run fn on the dedicated style thread and wait (for sync contexts)."""
    return _style_executor.submit(fn, *args).result()


def _ensure() -> bool:
    global _loaded, _system, _style, _err
    if _loaded:
        return _system is not None
    with _lock:
        if _loaded:
            return _system is not None
        try:
            # magenta-rt runs MusicCoCa on TFLite (CPU); the GPU belongs to JAX.
            # Full TensorFlow may not be installed — if it is, keep it off GPU.
            try:
                import tensorflow as tf  # noqa: F401

                tf.config.set_visible_devices([], "GPU")
            except ModuleNotFoundError:
                pass
            # L4 24GB: JAX preallocation fights its own big allocs — deploy with
            # XLA_PYTHON_CLIENT_PREALLOCATE=false, TF_GPU_ALLOCATOR=cuda_malloc_async.

            # upstream: magenta/magenta-realtime@694a545 magenta_rt/jax/system.py —
            # MagentaRT2System(size=..., ...); generate(conditioning, frames=25,
            # state) -> (audio.Waveform, MagentaRT2State). 25 frames ≈ 1s.
            from magenta_rt.jax.system import MagentaRT2System
            from magenta_rt.musiccoca import MusicCoCa

            def _build():
                global _style, _system
                _style = MusicCoCa()
                _system = MagentaRT2System(size=MODEL_SIZE, style_model=_style)

            # Construct on the style thread so the TFLite interpreters live
            # where they'll be invoked.
            _on_style_thread(_build)
        except Exception as e:  # noqa: BLE001
            _err = f"{type(e).__name__}: {str(e)[:300]}"
            _system = None
        finally:
            _loaded = True
    return _system is not None


def _warm_up() -> None:
    """One dummy generate to absorb the JAX compile (~10-30s)."""
    global _warm
    if _warm or not _ensure():
        return
    with _lock:
        if _warm:
            return
        try:
            emb = _on_style_thread(lambda: _normalize(_style.embed("warmup jazz")))
            tokens = _on_style_thread(_style.tokenize, emb)
            _generate_from_tokens(tokens, None)
            _warm = True
        except Exception as e:  # noqa: BLE001
            global _err
            import traceback

            traceback.print_exc()
            _err = f"warmup: {type(e).__name__}: {str(e)[:200]}"


def _normalize(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32).reshape(-1)
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-9 else v


def _slerp(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    """Spherical interpolation between two unit vectors (guarded for near-
    parallel inputs)."""
    dot = float(np.clip(np.dot(a, b), -1.0, 1.0))
    th = float(np.arccos(dot))
    if th < 1e-4:
        return _normalize(a * (1 - t) + b * t)
    return _normalize(
        (np.sin((1 - t) * th) * a + np.sin(t * th) * b) / np.sin(th)
    )


def _embed_anchor(anchor: dict) -> np.ndarray:
    """Style embedding from text tags or reference audio bytes."""
    if anchor.get("audio_b64"):
        import soundfile as sf
        from magenta_rt.audio import Waveform

        data, sr = sf.read(io.BytesIO(base64.b64decode(anchor["audio_b64"])), dtype="float32")
        # upstream: magenta_rt/musiccoca.py — MusicCoCa.embed accepts a Waveform.
        return _normalize(_style.embed(Waveform(data, sr)))
    return _normalize(_style.embed(str(anchor.get("text") or "ambient")))


def _generate_from_tokens(tokens, state):
    """One CHUNK_S-second stereo chunk conditioned on pre-tokenized style.
    Tokenization happens on the style thread; generation (JAX) is thread-safe."""
    frames = max(1, int(round(CHUNK_S * 25)))  # 25 frames/sec
    # upstream: magenta_rt/jax/system.py generate() — conditioning dict carries
    # the (tokenized) style; ADAPTATION POINT: verify the conditioning key
    # against the pinned notebook (notebooks/python_inference_demo.ipynb) at
    # deploy time.
    conditioning = {"style": tokens}
    waveform, new_state = _system.generate(conditioning, frames=frames, state=state)
    samples = np.asarray(waveform.samples)
    if samples.ndim == 1:
        samples = np.stack([samples, samples], axis=1)
    pcm = np.clip(samples, -1.0, 1.0)
    return (pcm * 32767).astype("<i2").reshape(-1).tobytes(), new_state


@app.get("/health")
def health():
    ok = _ensure()
    if ok and not _warm:
        _warm_up()
    return {"ok": True, "service": "mrt", "loaded": _loaded, "error": _err, "warm": _warm}


@app.websocket("/session")
async def session(ws: WebSocket):
    await ws.accept()
    if not _session_sem.acquire(blocking=False):
        await ws.send_text(json.dumps({"type": "busy"}))
        await ws.close(code=1013, reason="busy")
        return
    try:
        if not _ensure():
            await ws.send_text(json.dumps({"type": "error", "message": _err or "load failed"}))
            await ws.close(code=1011, reason="load_failed")
            return

        init = json.loads(await ws.receive_text())
        weight = float(init.get("weight", 0.5))
        loop = asyncio.get_event_loop()
        # Sequential, on the single style thread — TFLite interpreters can't
        # take concurrent or cross-thread invokes.
        emb_a = await loop.run_in_executor(_style_executor, _embed_anchor, init.get("a") or {})
        emb_b = await loop.run_in_executor(_style_executor, _embed_anchor, init.get("b") or {})

        await ws.send_text(
            json.dumps({"type": "meta", "sr": SR, "channels": CHANNELS, "chunkSec": CHUNK_S})
        )

        running = True

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
        state = None
        started = time.time()
        try:
            while running:
                if time.time() - started > SESSION_CAP_S:
                    await ws.close(code=1000, reason="session_cap")
                    break
                style_vec = _slerp(emb_a, emb_b, weight)  # latest weight each chunk
                tokens = await loop.run_in_executor(_style_executor, _style.tokenize, style_vec)
                pcm, state = await loop.run_in_executor(None, _generate_from_tokens, tokens, state)
                await ws.send_bytes(pcm)
        finally:
            running = False
            read_task.cancel()
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 — log it; silent sessions are undebuggable
        import traceback

        traceback.print_exc()
        try:
            await ws.send_text(json.dumps({"type": "error", "message": "session failed"}))
        except Exception:
            pass
    finally:
        _session_sem.release()
        try:
            await ws.close()
        except Exception:
            pass
