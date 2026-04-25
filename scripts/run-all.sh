#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Load env (root-only file) and run the pipeline in one privileged shell.
# This avoids loosening permissions on /etc/islamic-studies-at-mcct.env.
sudo bash -lc '
  set -euo pipefail
  set -a
  source /etc/islamic-studies-at-mcct.env
  set +a

  cd "'"$(pwd)"'"

  node scripts/fetch-youtube.mjs
  node scripts/enrich-videos.mjs
  npm run build
'
