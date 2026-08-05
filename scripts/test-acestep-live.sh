#!/usr/bin/env bash
# Wait out the acestep cold-start weight download, then run a real 30s
# generation through the web one-shot route and print the summary.
COOKIES=${COOKIES:-/Users/hayeshelsper/.claude/jobs/393b64e8/tmp/cookies.txt}
sleep "${WAIT_SEC:-420}"
curl -s -b "$COOKIES" -X POST https://web-717795396324.us-central1.run.app/api/studio/generate \
  -H "Content-Type: application/json" \
  -d '{"source":{"kind":"artist","mbid":"5182c1d9-c7d2-4dad-afa0-ccfeada921a8"},"engine":"acestep","durationSec":30,"lyrics":"[inst]"}' \
  --max-time 580 | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps({'error': d.get('error'), 'clip': (d.get('clip') or '')[:80], 'overall': (d.get('scorecard') or {}).get('overall')}))"
