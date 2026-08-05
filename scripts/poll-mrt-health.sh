#!/usr/bin/env bash
# Poll the crossfade health proxy until MRT reports warm (or 12 tries).
COOKIES=${COOKIES:-/Users/hayeshelsper/.claude/jobs/393b64e8/tmp/cookies.txt}
for i in $(seq 1 12); do
  out=$(curl -s -b "$COOKIES" --max-time 110 https://web-717795396324.us-central1.run.app/api/crossfade/health)
  echo "try $i: $out"
  case "$out" in *'"warm":true'*) echo WARM; exit 0;; esac
  sleep 25
done
echo "NOT WARM after 12 tries"
exit 1
