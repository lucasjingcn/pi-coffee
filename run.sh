#!/usr/bin/env bash
# Start the pi-coffee coordinator daemon. Must run as the SAME Unix user as your MCP
# client, and as the user whose pi credentials the spawned workers use.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Load settings written by `npm run setup` (provider API key, model, pi path).
ENV_FILE="${PI_COFFEE_ENV_FILE:-$HOME/.pi-coffee/env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

exec node dist/index.js "$@"
