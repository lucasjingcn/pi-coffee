#!/usr/bin/env bash
# Install pi-coffee as a systemd service.
#
#   Run as root            -> system service   (/etc/systemd/system/pi-coffee.service)
#   Run as a normal user   -> user service     (~/.config/systemd/user/pi-coffee.service)
#
# The daemon must run as a user whose `pi` is installed and authenticated.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_NAME="pi-coffee"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found on PATH (install Node >= 22.19)" >&2
  exit 1
fi
if [ ! -f "$DIR/dist/index.js" ]; then
  echo "error: $DIR/dist/index.js not found. Run: npm install && npm run build" >&2
  exit 1
fi

DAEMON_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$HOME/.pi/agent/bin"

# systemd expands '%' specifiers in unit values, so a literal percent sign must
# be written as '%%'. ExecStart= and Environment= split unquoted values on
# whitespace and process C-style escapes inside double quotes; ExecStart= also
# substitutes variables at runtime. The ':' executable prefix disables that
# expansion for these fixed paths, preserving literal dollar signs in both the
# executable and its arguments. WorkingDirectory= is taken verbatim, so only
# its percent specifiers need escaping.
systemd_path_escape() {
  printf '%s' "$1" | sed -e 's/%/%%/g'
}

systemd_quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"
}

SYSTEMD_WORKDIR="$(systemd_path_escape "$DIR")"
SYSTEMD_NODE="$(systemd_quote "$NODE_BIN")"
SYSTEMD_START="$(systemd_quote "$DIR/scripts/start.mjs")"

ENV_BLOCK="Environment=$(systemd_quote "PATH=$DAEMON_PATH")"
if [ -n "${PI_COFFEE_ENV_FILE:-}" ]; then
  ENV_BLOCK="$ENV_BLOCK
Environment=$(systemd_quote "PI_COFFEE_ENV_FILE=$PI_COFFEE_ENV_FILE")"
fi

if [ "$(id -u)" = "0" ]; then
  UNIT="/etc/systemd/system/$UNIT_NAME.service"
  cat > "$UNIT" <<EOF
[Unit]
Description=pi-coffee - Codex-as-manager MCP for parallel pi workers
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$SYSTEMD_WORKDIR
$ENV_BLOCK
ExecStart=:$SYSTEMD_NODE $SYSTEMD_START
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$UNIT_NAME"
  echo "installed system service: $UNIT"
  echo "  endpoint: check PI_COFFEE_PORT in the setup file (default http://127.0.0.1:8787/mcp)"
  echo "  status:   systemctl status $UNIT_NAME"
  echo "  logs:     journalctl -u $UNIT_NAME -f"
  echo "  stop:     systemctl disable --now $UNIT_NAME"
else
  UDIR="$HOME/.config/systemd/user"
  UNIT="$UDIR/$UNIT_NAME.service"
  mkdir -p "$UDIR"
  cat > "$UNIT" <<EOF
[Unit]
Description=pi-coffee - Codex-as-manager MCP for parallel pi workers

[Service]
Type=simple
WorkingDirectory=$SYSTEMD_WORKDIR
$ENV_BLOCK
ExecStart=:$SYSTEMD_NODE $SYSTEMD_START
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME"
  echo "installed user service: $UNIT"
  echo "  endpoint: check PI_COFFEE_PORT in the setup file (default http://127.0.0.1:8787/mcp)"
  echo "  start on boot (run once): loginctl enable-linger $USER"
  echo "  status:   systemctl --user status $UNIT_NAME"
  echo "  logs:     journalctl --user -u $UNIT_NAME -f"
  echo "  stop:     systemctl --user disable --now $UNIT_NAME"
fi
