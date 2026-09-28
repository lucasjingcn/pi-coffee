#!/usr/bin/env bash
# Install pi-coffee: build it, install the Codex skill, register the MCP server, and
# set up pi so workers can authenticate without a separate `/login` step.
# Run this as the SAME Unix user that runs your MCP client.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${PI_COFFEE_PORT:-8787}"
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
echo "==> register MCP server with Codex (stdio proxy -> http://127.0.0.1:$PORT/mcp)"
NODE_BIN="$(command -v node || echo node)"
if command -v codex >/dev/null 2>&1; then
  codex mcp remove pi >/dev/null 2>&1 || true
  codex mcp add pi -- "$NODE_BIN" "$DIR/dist/stdio-proxy.js"
else
  echo "   codex not on PATH; register manually in ~/.codex/config.toml:"
  echo "     [mcp_servers.pi]"
  echo "     command = \"$NODE_BIN\""
  echo "     args = [\"$DIR/dist/stdio-proxy.js\"]"
fi

# --- pi binary -------------------------------------------------------------
find_pi() {
  if [ -n "${PI_COFFEE_PI_BIN:-}" ]; then
    if [ -x "${PI_COFFEE_PI_BIN}" ]; then echo "${PI_COFFEE_PI_BIN}"; return 0; fi
    if command -v "${PI_COFFEE_PI_BIN}" >/dev/null 2>&1; then command -v "${PI_COFFEE_PI_BIN}"; return 0; fi
  fi
  if command -v pi >/dev/null 2>&1; then command -v pi; return 0; fi
  if [ -x "$HOME/.pi/agent/bin/pi" ]; then echo "$HOME/.pi/agent/bin/pi"; return 0; fi
  return 1
}

if PI_PATH="$(find_pi)"; then
  echo "==> pi found: $PI_PATH"
else
  echo "==> pi not found"
  if [ "${PI_COFFEE_SKIP_PI_INSTALL:-0}" = "1" ]; then
    echo "   PI_COFFEE_SKIP_PI_INSTALL=1; skipping."
  else
    install_pi=1
    if [ -t 0 ] && [ "${PI_COFFEE_YES:-0}" != "1" ]; then
      read -r -p "   Install pi now? [Y/n] " reply
      case "$reply" in [nN]*) install_pi=0 ;; esac
    fi
    if [ "$install_pi" = "1" ]; then
      if command -v curl >/dev/null 2>&1; then
        echo "   installing via https://pi.dev/install.sh"
        curl -fsSL https://pi.dev/install.sh | sh
      else
        echo "   installing via npm (global)"
        npm install -g --ignore-scripts @earendil-works/pi-coding-agent
      fi
    else
      echo "   skipped. Workers cannot start until pi is installed."
    fi
  fi
fi

# --- provider credentials --------------------------------------------------
# pi reads API keys from the environment, so storing a key and a model id here
# removes the need to run `/login` inside pi.
if [ "${PI_COFFEE_SKIP_SETUP:-0}" != "1" ] && [ -t 0 ]; then
  echo "==> provider setup"
  node "$DIR/scripts/setup.mjs" || true
fi

# --- verify ----------------------------------------------------------------
echo "==> doctor"
node "$DIR/scripts/doctor.mjs" || true

cat <<EOF

Done. Next:
  1. Start the daemon (same user as your MCP client):   $DIR/run.sh
  2. Restart your MCP client. It connects and exposes the pi_* tools.
EOF
