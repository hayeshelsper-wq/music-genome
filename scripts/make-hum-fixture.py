# Generate mocks/fixtures/hum.webm — a clean sine "hum" (5 notes, hann-shaped,
# 100-400 Hz so pyin's default hum range hears it) encoded to webm/opus via
# ffmpeg. Run with any python that has numpy+soundfile; needs ffmpeg on PATH.
import os
import subprocess
import tempfile

import numpy as np
import soundfile as sf

SR = 48000
# G3 A3 B3 D4 B3 — a singable little motif, 0.6s per note
PITCHES = [196.0, 220.0, 246.9, 293.7, 246.9]
DUR = 0.6

wav = np.concatenate(
    [
        0.6 * np.sin(2 * np.pi * f * np.arange(int(SR * DUR)) / SR) * np.hanning(int(SR * DUR))
        for f in PITCHES
    ]
).astype(np.float32)

out_dir = os.path.join(os.path.dirname(__file__), "..", "mocks", "fixtures")
os.makedirs(out_dir, exist_ok=True)
out = os.path.join(out_dir, "hum.webm")

fd, tmp = tempfile.mkstemp(suffix=".wav")
os.close(fd)
sf.write(tmp, wav, SR)
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-c:a", "libopus", "-b:a", "48k", out],
    check=True,
)
os.unlink(tmp)
print(f"wrote {out} ({os.path.getsize(out)} bytes)")
