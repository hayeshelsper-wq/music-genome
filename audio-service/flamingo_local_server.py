"""
Audio Flamingo 3 inference server — runs NVIDIA's music-specialized audio-LLM
(`nvidia/audio-flamingo-3-hf`). Runs as its own process so the heavy/bleeding-edge
ML deps (transformers `main`, a CUDA/torch stack) stay isolated from the main
audio-service. The caller POSTs an audio file to /describe; this server transcribes
the musician-level description.

Runs in two environments from the same code:
  * Local dev (Apple Silicon): CPU only — torch's MPS/Metal kernels hard-assert on
    this model's matmuls. ~1–2 min/clip. The 637M audio encoder is kept in fp32
    (CPU conv1d can't do bf16) while the 7B LLM runs bf16 (~18GB peak).
  * Cloud Run + NVIDIA L4 (CUDA): full bf16 on GPU — no Metal bugs, inference in
    seconds, no fp32 split needed.

HF_HOME points the ~16GB model cache wherever you want it (external SSD locally; a
baked image layer or mounted volume on Cloud Run). Set it BEFORE importing
transformers. The model loads lazily on the first /describe call.
"""
import os

# HF cache location — must be set before transformers is imported.
_cache = os.environ.get("HF_HOME") or os.environ.get("MUSIC_FLAMINGO_CACHE")
if _cache:
    os.environ["HF_HOME"] = _cache
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import tempfile
import threading

import torch
from fastapi import FastAPI, File, Form, UploadFile

MODEL_ID = os.environ.get("MUSIC_FLAMINGO_MODEL", "nvidia/audio-flamingo-3-hf")
MAX_NEW_TOKENS = int(os.environ.get("MUSIC_FLAMINGO_MAX_TOKENS", "512"))

# Which audio-LLM architecture to serve:
#   af3    → AudioFlamingo3ForConditionalGeneration (nvidia/audio-flamingo-3-hf)
#   afnext → AutoModel (nvidia/audio-flamingo-next-*-hf), newer (Apr 2026),
#            loaded for the A/B comparison. Same processor/chat-template flow but
#            a generic AutoModel class, a double-nested conversation, and a
#            repetition_penalty, per NVIDIA's model card.
ARCH = os.environ.get("MUSIC_FLAMINGO_ARCH", "af3").lower()

DEFAULT_PROMPT = (
    "Act as a professional music analyst. Describe this track in full detail: "
    "genre, mood, key, tempo, chords and harmony, instrumentation, production "
    "style, timbre, vocal characteristics, lyrical themes, and song structure."
)

# AF3 stops after a terse ~200-token summary by default. This suffix is appended
# to whatever prompt arrives so the model writes an expansive, multi-paragraph
# read — bumping MUSIC_FLAMINGO_MAX_TOKENS alone does nothing because the model
# was ending naturally well under the cap, not getting truncated.
VERBOSITY_SUFFIX = (
    " Write a thorough, in-depth analysis of at least 350 words across multiple "
    "paragraphs. For EACH aspect, give specific, concrete observations and "
    "examples from what you actually hear — describe the instruments and their "
    "interplay, the production choices, how the arrangement evolves section by "
    "section, and the emotional effect. Be richly detailed and expansive; do not "
    "write a short summary."
)

app = FastAPI()

_model = None
_processor = None
_load_error: str | None = None
_lock = threading.Lock()


def _device() -> str:
    dev = os.environ.get("MUSIC_FLAMINGO_DEVICE")
    if dev:
        return dev
    if torch.cuda.is_available():
        return "cuda"  # Cloud Run L4 — full bf16, fast
    return "cpu"  # local: MPS asserts on this model, so CPU


def _dtype():
    name = os.environ.get("MUSIC_FLAMINGO_DTYPE")
    if name:
        return getattr(torch, name)
    return torch.bfloat16


def _split_audio_tower() -> bool:
    """The processor emits fp32 audio features, so the 637M audio encoder's conv
    mismatches a bf16 weight on BOTH CPU and CUDA ("Input type (float) and bias
    type (BFloat16)"). Keep the (small) encoder in fp32 and let the hook cast its
    output back to the LLM dtype. Only skip this when running full fp32 anyway."""
    return _dtype() != torch.float32


def _cast_audio_out(module, inputs, output):
    dt = _dtype()
    if torch.is_tensor(output):
        return output.to(dt)
    if hasattr(output, "last_hidden_state"):
        output.last_hidden_state = output.last_hidden_state.to(dt)
        return output
    if isinstance(output, tuple):
        return tuple(
            x.to(dt) if torch.is_tensor(x) and torch.is_floating_point(x) else x
            for x in output
        )
    return output


def _ensure_loaded() -> None:
    global _model, _processor, _load_error
    if _model is not None or _load_error is not None:
        return
    with _lock:
        if _model is not None or _load_error is not None:
            return
        try:
            from transformers import AutoProcessor

            processor = AutoProcessor.from_pretrained(MODEL_ID)
            if ARCH == "afnext":
                # AF-Next captioner's config declares architecture
                # `MusicFlamingoForConditionalGeneration` (native in transformers,
                # no auto_map). AutoModel returns the base encoder with no
                # `.generate`, so load the generation class explicitly. Plain bf16
                # on CUDA per NVIDIA's card (no fp32 audio-tower split).
                import transformers

                ModelCls = getattr(
                    transformers, "MusicFlamingoForConditionalGeneration", None
                ) or getattr(transformers, "AutoModelForCausalLM")
                dev = _device()
                load_kwargs = {
                    "torch_dtype": _dtype(),
                    "low_cpu_mem_usage": True,
                }
                # Stream shards straight onto the GPU via accelerate instead of
                # staging the whole ~16GB model in CPU RAM and then .to(cuda): at
                # the 16Gi memory limit that CPU staging hangs (thrash) right
                # after "Loading weights 100%" and never finishes, so the model
                # never goes warm. device_map keeps the CPU footprint to ~one
                # shard at a time.
                if dev == "cuda":
                    load_kwargs["device_map"] = "cuda"
                model = ModelCls.from_pretrained(MODEL_ID, **load_kwargs)
                if dev != "cuda":
                    model.to(dev)
                # Same audio-tower dtype split as AF3: the processor emits fp32
                # `input_features` but the AF-Whisper conv weights are bf16. Keep
                # the whole audio_tower in fp32 and cast its output back to the LLM
                # dtype via the hook. The tower lives at model.model.audio_tower.
                if _split_audio_tower():
                    base = getattr(model, "model", model)
                    tower = getattr(base, "audio_tower", None)
                    if tower is not None:
                        tower.float()
                        tower.register_forward_hook(_cast_audio_out)
            else:
                from transformers import AudioFlamingo3ForConditionalGeneration

                model = AudioFlamingo3ForConditionalGeneration.from_pretrained(
                    MODEL_ID,
                    torch_dtype=_dtype(),
                    low_cpu_mem_usage=True,
                )
                model.to(_device())
                if _split_audio_tower() and hasattr(model.model, "audio_tower"):
                    model.model.audio_tower.float()
                    model.model.audio_tower.register_forward_hook(_cast_audio_out)
            model.eval()
            _processor = processor
            _model = model
        except Exception as e:  # noqa: BLE001 — surfaced to the caller
            _load_error = f"{type(e).__name__}: {e}"


def _run(audio_path: str, prompt: str) -> dict:
    try:
        message = {
            "role": "user",
            "content": [
                {"type": "text", "text": ""},
                {"type": "audio", "path": audio_path},
            ],
        }
        if ARCH == "afnext":
            # The captioner is verbose by design — keep the prompt clean (no AF3
            # verbosity nudge) and let it caption. Conversation is double-nested
            # (a batch of one) per NVIDIA's card; generate with a repetition_penalty.
            message["content"][0]["text"] = (prompt or DEFAULT_PROMPT).rstrip()
            conversation = [[message]]
            gen_kwargs = {"max_new_tokens": MAX_NEW_TOKENS, "repetition_penalty": 1.2}
        else:
            message["content"][0]["text"] = (prompt or DEFAULT_PROMPT).rstrip() + VERBOSITY_SUFFIX
            conversation = [message]
            gen_kwargs = {"max_new_tokens": MAX_NEW_TOKENS}
        inputs = _processor.apply_chat_template(
            conversation,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
        ).to(_model.device)
        with torch.no_grad():
            outputs = _model.generate(**inputs, **gen_kwargs)
        prompt_len = inputs["input_ids"].shape[1]
        text = _processor.batch_decode(
            outputs[:, prompt_len:], skip_special_tokens=True
        )[0].strip()
        # AF-Next-think emits <think>…</think> traces; strip them if present.
        if ARCH == "afnext" and "</think>" in text:
            text = text.split("</think>")[-1].strip()
        return {"description": text}
    except Exception as e:  # noqa: BLE001 — best-effort, never crash the pipeline
        return {"description": "", "error": f"{type(e).__name__}: {str(e)[:300]}"}


@app.get("/health")
def health():
    return {
        "ok": True,
        "loaded": _model is not None,
        "device": _device(),
        "model": MODEL_ID,
        "arch": ARCH,
        "hf_home": os.environ.get("HF_HOME"),
        "load_error": _load_error,
    }


@app.on_event("startup")
def _eager_warm() -> None:
    """Load the model in a background thread the moment the container starts.

    The whole pipeline is warm-gated: callers only send /describe once is_warm()
    (i.e. /health reports loaded=true) is true. But nothing else triggers the
    first load — /health just reports state — so a cold container would sit at
    loaded=false forever and the warm-gate would never open (deadlock). Loading
    here, off the request path, makes the container become warm on its own.
    Backgrounded so uvicorn finishes startup and /health stays responsive (and
    keeps reporting loaded=false) while the ~1-2min GCS-mounted load runs."""

    def _bg() -> None:
        print("[startup] eager model load starting…", flush=True)
        try:
            _ensure_loaded()
            if _load_error:
                print(f"[startup] model load FAILED: {_load_error}", flush=True)
            else:
                print("[startup] model loaded — warm", flush=True)
        except Exception as e:  # noqa: BLE001
            print(
                f"[startup] model load EXCEPTION: {type(e).__name__}: {e}",
                flush=True,
            )

    threading.Thread(target=_bg, daemon=True).start()


@app.post("/describe")
async def describe(
    file: UploadFile = File(...),
    prompt: str = Form(DEFAULT_PROMPT),
):
    """Accept an uploaded audio clip (wav/mp3/flac) and return AF3's description.
    Upload (not a shared path) so this works as its own Cloud Run service."""
    _ensure_loaded()
    if _load_error:
        return {"description": "", "error": f"model load failed — {_load_error[:300]}"}
    suffix = os.path.splitext(file.filename or "clip.wav")[1] or ".wav"
    fd, tmp = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(await file.read())
        return _run(tmp, prompt)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
