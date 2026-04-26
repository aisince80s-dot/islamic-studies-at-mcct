#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

sudo bash -lc '
  set -euo pipefail
  set -a
  source /etc/islamic-studies-at-mcct.env
  set +a

  cd "'"$(pwd)"'"

  node scripts/fetch-youtube.mjs
  # Micro-batch (cost-effective without Anthropic Batch API)
  MAX_VIDEOS=${MAX_VIDEOS:-200} CONCURRENCY=${CONCURRENCY:-6} node scripts/enrich-videos-microbatch.mjs
'

# Push updated JSON (site deployment is handled by GitHub Actions)
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -i /data/.openclaw/workspace/.openclaw/github_deploy_key" \
  bash -lc './scripts/push-to-github.sh'
