#!/usr/bin/env bash
# Install pi-coffee: build it, install the Codex skill, register the MCP server, and
# set up pi so workers can authenticate without a separate `/login` step.
# Run this as the same user that runs your MCP client.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Updating a live coordinator would interrupt its workers. Leave it untouched.
case "$(uname -s)" in
  Darwin)
    if launchctl print "gui/$(id -u)/com.picoffee.daemon" 2>/dev/null | grep -q 'state = running'; then
      echo "error: pi-coffee is running. Stop it after workers finish, then rerun npm run install:local." >&2
      exit 1
    fi ;;
  Linux)
    if systemctl --user is-active --quiet pi-coffee 2>/dev/null; then
      echo "error: pi-coffee is running. Stop it after workers finish, then rerun npm run install:local." >&2
      exit 1
    fi ;;
esac

CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"

# --- prerequisites ---------------------------------------------------------
command -v node >/dev/null 2>&1 || { echo "error: node is required (>= 22.19)"; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_minor="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 19 ]; }; then
  echo "error: node >= 22.19 is required (found $(node -v))"
  exit 1
fi
command -v git >/dev/null 2>&1 || { echo "error: git is required"; exit 1; }

# --- build -----------------------------------------------------------------
echo "==> npm install"
npm install

echo "==> build"
npm run build

# --- Codex skill -----------------------------------------------------------
echo "==> install Codex skill -> $CODEX_HOME_DIR/skills/pi-orchestrator"
mkdir -p "$CODEX_HOME_DIR/skills/pi-orchestrator"
cp "$DIR/codex/pi-orchestrator/SKILL.md" "$CODEX_HOME_DIR/skills/pi-orchestrator/SKILL.md"

# --- register the MCP server ----------------------------------------------
echo "==> register MCP server with Codex (stdio proxy reads the same setup file as the daemon)"
NODE_BIN="$(command -v node || echo node)"
if ! command -v codex >/dev/null 2>&1; then
  echo "error: Codex CLI is required on PATH to register the MCP server" >&2
  exit 1
fi
codex mcp remove pi >/dev/null 2>&1 || true
codex mcp add pi -- "$NODE_BIN" "$DIR/scripts/proxy.mjs"

echo "==> install user pi command"
npm run install:cli

# --- provider credentials --------------------------------------------------
# pi reads API keys from the environment, so storing a key and a model id here
# removes the need to run `/login` inside pi.
if [ "${PI_COFFEE_SKIP_SETUP:-0}" != "1" ] && [ -t 0 ]; then
  echo "==> provider setup"
  node "$DIR/scripts/setup.mjs"
fi

# --- verify ----------------------------------------------------------------
echo "==> doctor"
node "$DIR/scripts/doctor.mjs" --background

echo "==> install current-user background startup"
case "$(uname -s)" in
  Darwin) bash "$DIR/deploy/macos/install-daemon.sh" ;;
  Linux) bash "$DIR/deploy/linux/install-service.sh" ;;
  *) echo "error: unsupported Unix platform" >&2; exit 1 ;;
esac

node "$DIR/scripts/check-health.mjs"
echo "Done. Restart Codex to load the pi_* tools."
