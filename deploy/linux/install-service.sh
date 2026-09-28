#!/usr/bin/env bash
# Install pi-mcp as a systemd service.
#
#   Run as root            -> system service   (/etc/systemd/system/pi-mcp.service)
#   Run as a normal user   -> user service     (~/.config/systemd/user/pi-mcp.service)
#
# The daemon must run as a user whose `pi` is installed and authenticated.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${PI_MCP_PORT:-8787}"
UNIT_NAME="pi-mcp"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found on PATH (install Node >= 18, ideally 20.11+)" >&2
  exit 1
fi
if [ ! -f "$DIR/dist/index.js" ]; then
  echo "error: $DIR/dist/index.js not found. Run: npm install && npm run build" >&2
  exit 1
fi

PI_BIN="$(command -v pi || true)"
DAEMON_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$HOME/.pi/agent/bin"

ENV_BLOCK="Environment=PATH=$DAEMON_PATH
Environment=PI_MCP_PORT=$PORT
Environment=PI_MCP_DATA_DIR=$HOME/.pi-mcp"
[ -n "$PI_BIN" ] && ENV_BLOCK="$ENV_BLOCK
Environment=PI_MCP_PI_BIN=$PI_BIN"
[ -n "${PI_MCP_DEFAULT_REPO:-}" ] && ENV_BLOCK="$ENV_BLOCK
Environment=PI_MCP_DEFAULT_REPO=$PI_MCP_DEFAULT_REPO"

if [ "$(id -u)" = "0" ]; then
  UNIT="/etc/systemd/system/$UNIT_NAME.service"
  cat > "$UNIT" <<EOF
[Unit]
Description=pi-mcp - Codex-as-manager MCP for parallel pi workers
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$DIR
$ENV_BLOCK
ExecStart=$NODE_BIN $DIR/dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$UNIT_NAME"
  echo "installed system service: $UNIT"
  echo "  endpoint: http://127.0.0.1:$PORT/mcp"
  echo "  status:   systemctl status $UNIT_NAME"
  echo "  logs:     journalctl -u $UNIT_NAME -f"
  echo "  stop:     systemctl disable --now $UNIT_NAME"
else
  UDIR="$HOME/.config/systemd/user"
  UNIT="$UDIR/$UNIT_NAME.service"
  mkdir -p "$UDIR"
  cat > "$UNIT" <<EOF
[Unit]
Description=pi-mcp - Codex-as-manager MCP for parallel pi workers

[Service]
Type=simple
WorkingDirectory=$DIR
$ENV_BLOCK
ExecStart=$NODE_BIN $DIR/dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME"
  echo "installed user service: $UNIT"
  echo "  endpoint: http://127.0.0.1:$PORT/mcp"
  echo "  start on boot (run once): loginctl enable-linger $USER"
  echo "  status:   systemctl --user status $UNIT_NAME"
  echo "  logs:     journalctl --user -u $UNIT_NAME -f"
  echo "  stop:     systemctl --user disable --now $UNIT_NAME"
fi
