#!/usr/bin/env bash
# Start the pi-coffee coordinator daemon. Must run as the SAME Unix user as your MCP
# client, and as the user whose pi credentials the spawned workers use.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# The Node entry loads the same setup file on every supported platform.
exec node scripts/start.mjs "$@"
