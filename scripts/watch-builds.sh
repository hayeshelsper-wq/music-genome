#!/usr/bin/env bash
# Poll Cloud Build until no builds are ongoing, then print the final table.
export CLOUDSDK_PYTHON=${CLOUDSDK_PYTHON:-/opt/homebrew/bin/python3.11}
PROJECT=${PROJECT:-project-ac194633-c061-471f-b56}
for _ in $(seq 1 120); do
  n=$(gcloud builds list --project="$PROJECT" --ongoing --format="value(id)" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" = "0" ]; then
    echo "ALL BUILDS FINISHED"
    gcloud builds list --project="$PROJECT" --limit=8 --format="table(id,status,createTime)"
    exit 0
  fi
  sleep 60
done
echo "TIMEOUT — still $n running"
exit 1
