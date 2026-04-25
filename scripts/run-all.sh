#!/usr/bin/env bash
set -euo pipefail

# Load env
set -a
source /etc/islamic-studies-at-mcct.env
set +a

cd "$(dirname "$0")/.."

node scripts/fetch-youtube.mjs
node scripts/enrich-videos.mjs

npm run build
