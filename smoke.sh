#!/usr/bin/env bash
# One-command end-to-end smoke test. Builds if needed, then runs scripts/smoke.mjs.
#   ./smoke.sh                # includes a couple of tiny live model calls
#   SMOKE_LIVE=0 ./smoke.sh   # deterministic checks only (no model needed)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
[ -f dist/index.js ] || npm run build
exec node scripts/smoke.mjs "$@"
