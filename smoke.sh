#!/usr/bin/env bash
# One-command end-to-end smoke test. Always builds source, then runs scripts/smoke.mjs.
#   ./smoke.sh                # includes a couple of tiny live model calls
#   SMOKE_LIVE=0 ./smoke.sh   # deterministic checks only, fake pi (no model/pi credentials)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
npm run build
exec node scripts/smoke.mjs "$@"
