# Bake the SAM Audio weights into the image at build time so cold starts don't
# re-download ~GBs from HF. Requires an HF token whose account has accepted the
# SAM Audio license (the weights are gated: manual access request).
import os

from huggingface_hub import snapshot_download

MODEL_ID = os.environ.get("SAM_AUDIO_MODEL", "facebook/sam-audio-base")
snapshot_download(MODEL_ID, token=os.environ.get("HF_TOKEN"))
print(f"baked {MODEL_ID}")
