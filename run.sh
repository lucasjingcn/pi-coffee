#!/usr/bin/env bash
# Start the pi-mcp coordinator daemon. Must run as the SAME Unix user as Codex
# (so workers, worktrees, and Codex all share file ownership), and as the user
# whose ~/.pi credentials the spawned `pi` workers use.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Optional overrides:
#   PI_MCP_PORT=8787
#   PI_MCP_DEFAULT_REPO=/path/to/main/repo
#   PI_MCP_WORKSPACE_ROOT=/path/for/worktrees
#   PI_MCP_PROVIDER=deepseek PI_MCP_MODEL=deepseek-flash
#   PI_MCP_TOKEN=secret            (also set for the extension automatically)
exec node dist/index.js "$@"
