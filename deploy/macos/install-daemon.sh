#!/usr/bin/env bash
# Install pi-mcp as a per-user macOS LaunchAgent so the daemon stays up and
# restarts on login/crash. Run from the project root:  ./deploy/macos/install-daemon.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${PI_MCP_PORT:-8787}"
LABEL="com.pimcp.daemon"
LA_DIR="$HOME/Library/LaunchAgents"
PLIST="$LA_DIR/$LABEL.plist"
LOG_DIR="$HOME/.pi-mcp/logs"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found on PATH. Install Node >= 18 (20.11+ recommended)." >&2
  exit 1
fi
if [ ! -f "$PROJECT_DIR/dist/index.js" ]; then
  echo "error: $PROJECT_DIR/dist/index.js not found. Run: npm install && npm run build" >&2
  exit 1
fi

mkdir -p "$LA_DIR" "$LOG_DIR"
chmod +x "$PROJECT_DIR/run.sh" 2>/dev/null || true

# launchd has a minimal PATH; make sure the daemon can find git + node + pi.
DAEMON_PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$HOME/.pi/agent/bin:$HOME/.bun/bin"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$DAEMON_PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>PI_MCP_PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/daemon.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/daemon.err.log</string>
</dict>
</plist>
EOF

# Reload (bootstrap is the modern verb; fall back to load on older macOS).
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
  :
else
  launchctl load "$PLIST"
fi

sleep 1
echo "installed LaunchAgent: $PLIST"
echo "  endpoint:  http://127.0.0.1:$PORT/mcp"
echo "  logs:      $LOG_DIR/daemon.{out,err}.log"
echo "  status:    launchctl print gui/$UID_NUM/$LABEL | head"
echo "  stop:      launchctl bootout gui/$UID_NUM/$LABEL"
