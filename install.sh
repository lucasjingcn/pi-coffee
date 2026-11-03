#!/usr/bin/env bash
# Install pi-coffee: build it, install the orchestrator skill, register the MCP server with every
# MCP client it finds, configure a provider, and start the per-user background daemon.
# Run this as the same user that runs your MCP client.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

usage() {
  cat <<'EOF'
pi-coffee installer

  npm run install:local [-- <setup options>]

Builds the project, installs the pinned pi CLI and the pi-orchestrator skill, registers the MCP
server "pi" with every client it finds (Codex and the pi CLI), configures a provider, and starts
the per-user background daemon. A missing client never aborts the install: the script reports how
to connect the client you do have.

Setup options (forwarded to `npm run setup`, so they also work non-interactively):
  --provider <name>       Provider id understood by pi (default: deepseek)
  --api-key <key>         Provider API key
  --api-key-env <VAR>     Override the env var name for the key
  --model <id>            Model id (default: deepseek-flash)
  --thinking <level>      off|minimal|low|medium|high|xhigh|max
  --skip-setup            Do not configure a provider now (`npm run setup` later)
  --help, -h              Show this help

Environment: PI_COFFEE_SKIP_SETUP=1 is the same as --skip-setup.
EOF
}

SKIP_SETUP="${PI_COFFEE_SKIP_SETUP:-0}"
SETUP_ARGS=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --skip-setup) SKIP_SETUP=1 ;;
    *) SETUP_ARGS+=("$arg") ;;
  esac
done

# Updating a live coordinator would interrupt its workers. Leave it untouched.
case "$(uname -s)" in
  Darwin)
    # Under sudo the daemon belongs to SUDO_USER's GUI domain, not root's.
    uid="$(id -u)"
    if [ -n "${SUDO_USER:-}" ]; then uid="$(id -u "$SUDO_USER" 2>/dev/null || printf '%s' "$uid")"; fi
    # Capture first: `launchctl ... | grep -q` returns 141 under `pipefail`
    # whenever grep exits before launchctl finishes writing, which silently
    # disabled this guard and let the install interrupt running workers.
    daemon_state="$(launchctl print "gui/$uid/com.picoffee.daemon" 2>/dev/null || true)"
    case "$daemon_state" in
      *"state = running"*)
        echo "error: pi-coffee is running. Stop it after workers finish, then rerun npm run install:local." >&2
        exit 1 ;;
    esac ;;
  Linux)
    # Check the system unit too: `systemctl --user` cannot reach the user bus
    # under sudo, so the user-only check silently passed during a root upgrade.
    # Under sudo, ask the invoking user's own systemd instead — the system unit
    # knows nothing about a --user install, so that half stays green otherwise.
    user_active=""
    if [ -n "${SUDO_USER:-}" ] && [ "$(id -u)" -eq 0 ]; then
      target_uid="$(id -u "$SUDO_USER" 2>/dev/null || true)"
      if [ -n "$target_uid" ]; then
        user_active="$(sudo -u "$SUDO_USER" XDG_RUNTIME_DIR="/run/user/$target_uid" \
          systemctl --user is-active pi-coffee 2>/dev/null || true)"
      fi
    else
      user_active="$(systemctl --user is-active pi-coffee 2>/dev/null || true)"
    fi
    if systemctl is-active --quiet pi-coffee 2>/dev/null || [ "$user_active" = "active" ]; then
      echo "error: pi-coffee is running. Stop it after workers finish, then rerun npm run install:local." >&2
      exit 1
    fi ;;
esac

# --- prerequisites ---------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js >= 22.19 is required and no node is on PATH." >&2
  echo "  macOS:  brew install node@22   (or: nvm install 22 && nvm use 22)" >&2
  echo "  Linux:  https://nodejs.org/en/download   (or: nvm install 22 && nvm use 22)" >&2
  exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_minor="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 19 ]; }; then
  echo "error: Node.js >= 22.19 is required (found $(node -v))." >&2
  echo "  Install a supported Node and rerun npm run install:local." >&2
  exit 1
fi
command -v git >/dev/null 2>&1 || { echo "error: git is required" >&2; exit 1; }

# --- build -----------------------------------------------------------------
echo "==> npm install"
npm install --no-audit --no-fund

echo "==> build"
npm run build

# --- agent skills ----------------------------------------------------------
# Codex reads its own directory; pi and other Agent Skills clients read the shared
# ~/.agents/skills location. The shared copy is what every client can load.
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
AGENTS_SKILLS_DIR="$HOME/.agents/skills"
echo "==> install shared agent skill -> $AGENTS_SKILLS_DIR/pi-orchestrator"
# Replace a linked directory with a real copy so the file copy below stays safe.
if [ -L "$AGENTS_SKILLS_DIR/pi-orchestrator" ]; then
  rm "$AGENTS_SKILLS_DIR/pi-orchestrator"
fi
mkdir -p "$AGENTS_SKILLS_DIR/pi-orchestrator"
cp "$DIR/codex/pi-orchestrator/SKILL.md" "$AGENTS_SKILLS_DIR/pi-orchestrator/SKILL.md"

if [ -d "$CODEX_HOME_DIR" ] || command -v codex >/dev/null 2>&1; then
  echo "==> install Codex skill -> $CODEX_HOME_DIR/skills/pi-orchestrator"
  mkdir -p "$CODEX_HOME_DIR/skills/pi-orchestrator"
  cp "$DIR/codex/pi-orchestrator/SKILL.md" "$CODEX_HOME_DIR/skills/pi-orchestrator/SKILL.md"
else
  echo "==> Codex not found; skipping its skill copy (the shared skill above covers other clients)"
fi

# --- MCP clients -----------------------------------------------------------
echo "==> install user pi command"
npm run install:cli

# Registers Codex and the pi CLI when present and prints how to connect the rest.
# A missing client is not an error; a failed registration restores the client config.
echo "==> register MCP server with detected clients"
REGISTER_STATUS=0
node "$DIR/scripts/register-clients.mjs" || REGISTER_STATUS=$?

# --- provider credentials --------------------------------------------------
# pi reads API keys from the environment, so storing a key and a model id here
# removes the need to run `/login` inside pi.
if [ "$SKIP_SETUP" = "1" ]; then
  echo "==> provider setup skipped (--skip-setup / PI_COFFEE_SKIP_SETUP=1)"
elif [ "${#SETUP_ARGS[@]}" -gt 0 ]; then
  echo "==> provider setup"
  node "$DIR/scripts/setup.mjs" ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}
elif [ -t 0 ]; then
  echo "==> provider setup"
  node "$DIR/scripts/setup.mjs"
else
  echo "==> provider setup skipped (no terminal). Later: npm run setup, or pass --provider/--api-key"
fi

# --- verify ----------------------------------------------------------------
echo "==> doctor"
DOCTOR_STATUS=0
DOCTOR_OUTPUT="$(node "$DIR/scripts/doctor.mjs" --background 2>&1)" || DOCTOR_STATUS=$?
printf '%s\n' "$DOCTOR_OUTPUT"
SETUP_PENDING=0
if [ "$DOCTOR_STATUS" -ne 0 ]; then
  if printf '%s\n' "$DOCTOR_OUTPUT" | grep -qE '^FAIL +credentials'; then
    # A missing key only breaks worker model calls, not the service: finish the install and
    # leave one clearly named action instead of a half-installed machine.
    echo "warning: no provider credential yet. The daemon will be installed; run 'npm run setup'."
    SETUP_PENDING=1
  else
    echo "error: preflight failed. Fix the failed check above, then rerun npm run install:local." >&2
    exit 1
  fi
fi

echo "==> install current-user background startup"
case "$(uname -s)" in
  Darwin) bash "$DIR/deploy/macos/install-daemon.sh" ;;
  Linux) bash "$DIR/deploy/linux/install-service.sh" ;;
  *) echo "error: unsupported Unix platform" >&2; exit 1 ;;
esac

if ! node "$DIR/scripts/check-health.mjs"; then
  echo "error: the background daemon did not become healthy." >&2
  echo "  logs:     $HOME/.pi-coffee/logs/daemon.{out,err}.log" >&2
  echo "  diagnose: npm run doctor" >&2
  exit 1
fi

# --- next steps ------------------------------------------------------------
# Report the port the daemon actually serves, not just the default.
DAEMON_PORT="$(node --input-type=module -e 'import {loadDaemonEnv} from "./scripts/lib/env.mjs"; loadDaemonEnv(); process.stdout.write(process.env.PI_COFFEE_PORT || "8787");' 2>/dev/null)" || DAEMON_PORT=8787
[ -n "$DAEMON_PORT" ] || DAEMON_PORT=8787
DAEMON_ENDPOINT="http://127.0.0.1:${DAEMON_PORT}/mcp"
if [ -n "${PI_COFFEE_URL:-}" ]; then DAEMON_ENDPOINT="${PI_COFFEE_URL%/}/mcp"; fi

case "$(uname -s)" in
  Darwin)
    RESTART_COMMAND="launchctl kickstart -k gui/\$(id -u)/com.picoffee.daemon"
    LOG_HINT="$HOME/.pi-coffee/logs/daemon.{out,err}.log" ;;
  *)
    RESTART_COMMAND="systemctl --user restart pi-coffee"
    LOG_HINT="journalctl --user -u pi-coffee  (or $HOME/.pi-coffee/logs)" ;;
esac

cat <<EOF

pi-coffee is installed and running.

  endpoint    $DAEMON_ENDPOINT
  data        $HOME/.pi-coffee
  env file    \${PI_COFFEE_ENV_FILE:-\$HOME/.pi-coffee/env}
  logs        $LOG_HINT
  restart     $RESTART_COMMAND

Next steps
  1. Restart your MCP client (Codex, pi, DSH, Claude, Cursor, ...); the pi_* tools appear then.
     What was registered is listed above under "MCP client registration".
  2. Check the daemon any time: node scripts/check-health.mjs      (preflight: npm run doctor)
  3. Prove this machine works without spending tokens: npm run demo
  4. First walkthrough: README.md ("Quick start"), docs/reference/operations.md, pi-orchestrator skill
  5. Upgrade later: npm run upgrade -- --timeout=300       Uninstall: docs/reference/operations.md
EOF

if [ "$SETUP_PENDING" = "1" ]; then
  cat <<EOF

! No provider credential is configured yet. Workers cannot start until you do this:

  npm run setup
  $RESTART_COMMAND
EOF
fi

if [ "$REGISTER_STATUS" -ne 0 ]; then
  cat <<EOF

! One MCP client registration failed (its previous configuration was restored).
  Retry it with: node scripts/register-clients.mjs
EOF
fi
