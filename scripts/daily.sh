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
  node scripts/enrich-videos-batch.mjs
'

# Push updated JSON (site deployment is handled by GitHub Actions)
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new -i /data/.openclaw/workspace/.openclaw/github_deploy_key" \
  bash -lc './scripts/push-to-github.sh'
