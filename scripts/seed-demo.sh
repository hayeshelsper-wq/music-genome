#!/usr/bin/env bash
# Seed V2 demo content on the live site (no Claude credits needed):
#   1. melody transcriptions for every showcase track (Firestore symbolic cache)
#   2. SAM extractions for three standard prompts per track (GCS + Firestore)
#   3. one hum -> production demo into the library
# Usage: AUTH_PASSWORD=... ./scripts/seed-demo.sh
set -uo pipefail
WEB=${WEB:-https://web-717795396324.us-central1.run.app}
JAR=$(mktemp)
FIXTURE="$(dirname "$0")/../mocks/fixtures/hum.webm"

echo "▸ login"
curl -s -c "$JAR" -X POST "$WEB/api/auth/login" -H "Content-Type: application/json" \
  -d "{\"password\":\"${AUTH_PASSWORD}\"}" | grep -q '"ok":true' || { echo "login failed"; exit 1; }

echo "▸ showcase list"
SONGS=$(curl -s -b "$JAR" "$WEB/api/showcase" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for s in d.get('songs', []):
    if s.get('previewUrl'):
        print('\t'.join([s['artist'], s['title'], s['previewUrl']]))
")
echo "$SONGS" | sed 's/\t/ — /;s/\thttp.*//' | head -20

echo "▸ 1/3 melody transcriptions (Demucs + basic-pitch — slow, cached forever)"
while IFS=$'\t' read -r artist title url; do
  [ -z "$url" ] && continue
  printf "  %s — %s: " "$artist" "$title"
  curl -s -b "$JAR" -X POST "$WEB/api/track/transcribe" -H "Content-Type: application/json" \
    --max-time 400 \
    -d "$(python3 -c "import json,sys; print(json.dumps({'previewUrl': sys.argv[1], 'artist': sys.argv[2], 'title': sys.argv[3], 'mode': 'melody'}))" "$url" "$artist" "$title")" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error') or f\"{len(d.get('notes',[]))} notes ({d.get('stem')})\")"
done <<< "$SONGS"

echo "▸ 2/3 SAM extractions (3 prompts per track; polls through cold GPU)"
extract() {  # url text
  for _ in $(seq 1 60); do
    out=$(curl -s -b "$JAR" -X POST "$WEB/api/track/extract" -H "Content-Type: application/json" \
      --max-time 400 \
      -d "$(python3 -c "import json,sys; print(json.dumps({'previewUrl': sys.argv[1], 'text': sys.argv[2]}))" "$1" "$2")")
    case "$out" in
      *'"warming":true'*) sleep 20; continue;;
      *) echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error') or ('cached' if d.get('cached') else 'extracted'))"; return;;
    esac
  done
  echo "gave up (still warming)"
}
while IFS=$'\t' read -r artist title url; do
  [ -z "$url" ] && continue
  for prompt in "the drums" "the bass line" "the lead vocal"; do
    printf "  %s — %s / %s: " "$artist" "$title" "$prompt"
    extract "$url" "$prompt"
  done
done <<< "$SONGS"

echo "▸ 3/3 hum demo"
HUM=$(curl -s -b "$JAR" -X POST "$WEB/api/hum" -F "file=@$FIXTURE;type=audio/webm" --max-time 300)
HUMID=$(echo "$HUM" | python3 -c "import json,sys; print(json.load(sys.stdin).get('humId') or '')")
if [ -n "$HUMID" ]; then
  echo "  hum $HUMID placed; producing (musicgen-melody, Black Sabbath style)…"
  curl -s -b "$JAR" -X POST "$WEB/api/hum/produce" -H "Content-Type: application/json" --max-time 580 \
    -d "{\"humId\":\"$HUMID\",\"styleMbid\":\"5182c1d9-c7d2-4dad-afa0-ccfeada921a8\",\"engine\":\"musicgen-melody\",\"verify\":true}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('  ', d.get('error') or f\"produced {d.get('producedId')} fidelity={d.get('melodicFidelity')}\")"
else
  echo "  hum seeding failed: $(echo "$HUM" | head -c 200)"
fi

rm -f "$JAR"
echo "✅ seeding done"
