#!/usr/bin/env bash
# Install pi-mcp: build, install the Codex skill, and register the MCP server.
# Run this as the SAME Unix user that runs Codex.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${PI_MCP_PORT:-8787}"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"

echo "==> npm install"
npm install

echo "==> build"
npm run build

echo "==> install Codex skill -> $CODEX_HOME_DIR/skills/pi-orchestrator"
mkdir -p "$CODEX_HOME_DIR/skills/pi-orchestrator"
cp "$DIR/codex/pi-orchestrator/SKILL.md" "$CODEX_HOME_DIR/skills/pi-orchestrator/SKILL.md"

echo "==> register MCP server with Codex (http://127.0.0.1:$PORT/mcp)"
if command -v codex >/dev/null 2>&1; then
  codex mcp remove pi >/dev/null 2>&1 || true
  codex mcp add pi --url "http://127.0.0.1:$PORT/mcp"
else
  echo "   codex not on PATH; register manually:"
  echo "   codex mcp add pi --url http://127.0.0.1:$PORT/mcp"
fi

cat <<EOF

Done. Next:
  1. Start the daemon (same user as Codex):   $DIR/run.sh
  2. Restart Codex. It will connect to pi-mcp and receive the 大总管 instructions.
EOF
