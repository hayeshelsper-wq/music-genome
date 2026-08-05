# Next Wave (V2) — consolidated HUMAN CHECKPOINT list

Everything a human must do, in order. Items marked ✅ were completed by the
agent during the V2 build (2026‑08‑05); ⬜ items need you.

## Licenses / gated weights
- ⬜ **SAM Audio** — `facebook/sam-audio-base` is **gated (manual access
  request)** on Hugging Face. Accept the SAM License with the account behind
  the `HF_TOKEN` secret, then build+deploy `sam-audio-service`
  (`deploy/cloudbuild.sam.yaml`) and set `SAM_AUDIO_URL` on `web`. Until then
  the Extract features degrade cleanly (route returns "not configured").
- ✅ **ACE‑Step 1.5** — MIT, weights ungated. No action.
- ✅ **Magenta RealTime** — code Apache‑2.0, weights **CC‑BY 4.0** (ungated).
  Attribution shipped in the README + /crossfade footer. No action.
- ✅ **basic‑pitch / MusicGen‑melody** — ungated. No action.

## Builds & deploys (agent ran these — verify they went green)
- ✅ Cloud Builds submitted for: `web` (v2 tag, with `_AUDIO_WS` build arg),
  `audio` (new deps: basic‑pitch[onnx], pretty_midi, websockets, pyfluidsynth,
  fluidsynth + FluidR3Mono soundfont), `musicgen` (**re‑baked with
  `MUSICGEN_MODEL=facebook/musicgen-melody`**), `acestep`, `mrt`,
  `lora-trainer`.
- ⬜ If the `acestep` / `mrt` image builds fail (upstream deps are the risky
  part), read the build logs; the server code marks every upstream call with
  `# upstream:` comments as adaptation points.
- ⬜ **Create the LoRA trainer job** (one‑time):
  `gcloud run jobs create lora-trainer --image <AR>/lora-trainer:v2-20260805
  --region us-central1 --gpu 1 --gpu-type nvidia-l4 --cpu 8 --memory 24Gi
  --task-timeout 3600 --max-retries 0` and grant its SA storage read on the
  uploads bucket, write on `loras/`, and `roles/datastore.user`.
  Then verify the headless training entrypoint (`LORA_TRAIN_CMD`) against the
  pinned ACE‑Step repo — the tutorial documents the Gradio path; the module
  path in `lora-trainer/train.py` is the marked adaptation point.
- ⬜ First **real LoRA training run** on your own catalog; sanity‑listen.

## Env & secrets
- ✅ `CROSSFADE_TOKEN_SECRET` created in Secret Manager.
- ✅ `STUDIO_MAX_ITERS` / `STUDIO_DNA_THRESHOLD` defaulted in code (4 / 80).
- ⬜ After the GPU services deploy, set on `web`: `ACESTEP_URL`, `MRT_URL`,
  (`SAM_AUDIO_URL` post‑license) — and on `audio-service`: `MRT_WS_URL`,
  `CROSSFADE_TOKEN_SECRET` (secret mount). The agent wires whatever deployed
  successfully during its deploy pass; re‑check `gcloud run services describe`.

## Deploy findings (2026‑08‑05 live QA)
- ✅ Fixed live: IPv6‑first DNS broke MusicBrainz on Cloud Run
  (`NODE_OPTIONS=--dns-result-order=ipv4first` on `web`).
- ✅ Crossfader architecture correction: the audio-service is IAM‑gated in
  prod, so a second public service **`audio-ws`** (same image,
  `PUBLIC_WS_ONLY=1` — only `/mrt/session` + `/health` reachable) fronts the
  browser; `NEXT_PUBLIC_AUDIO_WS` bakes its URL into the web bundle.
- ✅ MRT is LIVE (image `v2-mrt-7`) after four fixes: authenticated HF weight
  bake; MusicCoCa TFLite calls serialized on one dedicated thread (concurrent
  invokes crash); `XLA_PYTHON_CLIENT_PREALLOCATE=false` +
  `TF_GPU_ALLOCATOR=cuda_malloc_async`; generation paced to `MRT_AHEAD_S=4`
  so the fader responds in ~6s (tune `CHUNK_S=1.0` + `MRT_AHEAD_S=2` for ~3s).
  **Runs `mrt2_small`** — `mrt2_base`'s 8.13GiB style‑embed allocation does not
  fit a 24GB L4 next to the generator; bigger‑GPU follow‑up if base quality is
  wanted.
- ⬜ **acestep image bake is incomplete**: the handler downloads the actual
  DiT/LM checkpoints (~10GB across several HF repos) at cold start, which
  scale‑to‑zero re‑pays every time. Interim: `HF_TOKEN` + `--no-cpu-throttling`
  on the service. Proper fix: identify the exact repos the
  `acestep-v15-turbo` config resolves and bake them (or mount a GCS volume
  like the flamingo `-nobake` pattern).

## Live checks
- ⬜ Crossfader latency: if slider→ear exceeds ~2s on the live L4, set
  `CHUNK_S=1.0` on `mrt` and re‑evaluate.
- ⬜ Mobile Safari hum recording (audio/mp4 fallback path is unit‑covered but
  worth one real‑device check).
- ⬜ Local dev e2e (optional): run `gcloud auth application-default login` on
  this machine to give the local Next.js app Firestore/GCS access, then follow
  `mocks/README.md`.
