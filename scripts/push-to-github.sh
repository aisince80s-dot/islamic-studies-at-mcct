#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if git diff --quiet; then
  echo "No changes to commit"
  exit 0
fi

git add public/videos.json dist

git commit -m "chore: update videos + rebuild"

git push
