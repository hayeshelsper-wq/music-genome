"""Cloud Run Job: train an ACE-Step LoRA "voice" on the user's own uploads.

Env: LORA_ID (required), UPLOADS_BUCKET, GOOGLE_CLOUD_PROJECT,
LORAS_COLLECTION (default "loras"), UPLOADS_COLLECTION (default "uploads"),
LORA_EPOCHS / LORA_LR / LORA_BATCH (upstream-recommended defaults for 10-20
songs), LORA_TRAIN_CMD (override the training entrypoint).

Flow: read the loras/{id} Firestore record -> download every ownerUploadIds
audio from GCS -> prepare the upstream dataset layout (audio + lyrics
sidecars) -> run ACE-Step's LoRA recipe -> upload adapter_model.safetensors to
gs://$UPLOADS_BUCKET/loras/{id}/ -> patch status ready|error.
"""
import os
import shlex
import subprocess
import sys
import tempfile
import time
import traceback

from google.cloud import firestore, storage

LORA_ID = os.environ.get("LORA_ID", "")
BUCKET = os.environ.get("UPLOADS_BUCKET") or (
    f"{os.environ['GOOGLE_CLOUD_PROJECT']}-uploads" if os.environ.get("GOOGLE_CLOUD_PROJECT") else ""
)
LORAS_COLLECTION = os.environ.get("LORAS_COLLECTION", "loras")
UPLOADS_COLLECTION = os.environ.get("UPLOADS_COLLECTION", "uploads")

# upstream: ace-step/ACE-Step-1.5@6d467e4 docs/en/LoRA_Training_Tutorial.md —
# 10-20 songs: ~800 max epochs, batch 1, LR 1e-4 (LoRA); checkpoint every 5-10.
EPOCHS = int(os.environ.get("LORA_EPOCHS", "800"))
LR = os.environ.get("LORA_LR", "1e-4")
BATCH = int(os.environ.get("LORA_BATCH", "1"))


def main() -> int:
    if not LORA_ID:
        print("LORA_ID env var required", file=sys.stderr)
        return 2
    db = firestore.Client()
    doc = db.collection(LORAS_COLLECTION).document(LORA_ID)
    rec = doc.get().to_dict()
    if not rec:
        print(f"no lora record {LORA_ID}", file=sys.stderr)
        return 2

    doc.set({"status": "training", "startedAt": int(time.time() * 1000)}, merge=True)
    try:
        gcs = storage.Client()
        bucket = gcs.bucket(BUCKET)
        workdir = tempfile.mkdtemp(prefix="lora-")
        data_dir = os.path.join(workdir, "songs")
        out_dir = os.path.join(workdir, "out")
        os.makedirs(data_dir, exist_ok=True)
        os.makedirs(out_dir, exist_ok=True)

        # 1) download the owner's uploads (own-uploads-only is enforced at the
        #    API layer; the record only ever contains library upload ids).
        n = 0
        for uid in rec.get("ownerUploadIds", []):
            up = db.collection(UPLOADS_COLLECTION).document(uid).get().to_dict()
            if not up or not up.get("audioPath"):
                print(f"skip {uid}: no audio", file=sys.stderr)
                continue
            ext = os.path.splitext(up["audioPath"])[1] or ".mp3"
            dest = os.path.join(data_dir, f"{uid}{ext}")
            bucket.blob(up["audioPath"]).download_to_filename(dest)
            # upstream dataset layout wants {filename}.lyrics.txt beside each
            # song; instrumental/unknown lyrics use the [inst] tag.
            with open(os.path.join(data_dir, f"{uid}{ext}.lyrics.txt"), "w") as f:
                f.write(up.get("fullLyrics") or "[inst]")
            n += 1
        if n == 0:
            raise RuntimeError("no usable songs in ownerUploadIds")
        print(f"downloaded {n} songs")

        # 2) run the upstream recipe. The tutorial drives this through the
        #    Gradio pipeline (scan -> preprocess to tensors -> train); the
        #    headless module path below is the adaptation point — override with
        #    LORA_TRAIN_CMD after verifying against the pinned repo at deploy
        #    time (HUMAN CHECKPOINT).
        cmd = os.environ.get("LORA_TRAIN_CMD") or (
            f"python -m acestep.training.train_lora --data_dir {shlex.quote(data_dir)} "
            f"--output_dir {shlex.quote(out_dir)} --epochs {EPOCHS} --batch_size {BATCH} --lr {LR}"
        )
        print(f"training: {cmd}")
        subprocess.run(cmd, shell=True, check=True)

        # 3) upload the adapter
        adapter = None
        for root, _dirs, files in os.walk(out_dir):
            for fn in files:
                if fn.endswith(".safetensors"):
                    adapter = os.path.join(root, fn)
        if not adapter:
            raise RuntimeError("training produced no .safetensors adapter")
        gcs_prefix = f"loras/{LORA_ID}"
        bucket.blob(f"{gcs_prefix}/adapter_model.safetensors").upload_from_filename(adapter)
        print(f"uploaded gs://{BUCKET}/{gcs_prefix}/adapter_model.safetensors")

        doc.set(
            {
                "status": "ready",
                "trainedAt": int(time.time() * 1000),
                "steps": EPOCHS,
                "gcsPath": f"gs://{BUCKET}/{gcs_prefix}",
            },
            merge=True,
        )
        return 0
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        doc.set({"status": "error", "error": str(e)[:500]}, merge=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
