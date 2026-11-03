#!/usr/bin/env bash
# One-line installer: fetch the newest pi-coffee release, keep a stable copy, run its installer.
#
#   curl -fsSL https://raw.githubusercontent.com/lucasjingcn/pi-coffee/main/scripts/bootstrap.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/lucasjingcn/pi-coffee/main/scripts/bootstrap.sh | bash -s -- --provider deepseek --api-key sk-...
#
# The release tarball is preferred; when the GitHub API is unavailable (rate limit, offline
# mirror) the source archive of `main` is used instead. Everything after `--` is forwarded to
# install.sh, so `--help`, `--provider`, `--api-key`, `--model`, `--thinking` and
# `--skip-setup` behave exactly as they do for `npm run install:local`.
#
# Environment:
#   PI_COFFEE_APP_DIR             where the fetched copy lives (default: ~/.pi-coffee/app)
#   PI_COFFEE_BOOTSTRAP_ARCHIVE   local path or URL to use instead of GitHub (mirrors, tests)
set -euo pipefail

REPO="lucasjingcn/pi-coffee"
APP_DIR="${PI_COFFEE_APP_DIR:-$HOME/.pi-coffee/app}"

usage() {
  cat <<'EOF'
pi-coffee one-line installer

  bash <(curl -fsSL https://raw.githubusercontent.com/lucasjingcn/pi-coffee/main/scripts/bootstrap.sh)

  --dry-run        Print the archive that would be used and where it would be unpacked.
  --help, -h       Show this help.

All other options are forwarded to install.sh:
  --provider <name>   --api-key <key>   --model <id>   --thinking <level>
  --skip-setup        (or PI_COFFEE_SKIP_SETUP=1)

Git is not required: the installer builds from the unpacked copy under
$PI_COFFEE_APP_DIR (default ~/.pi-coffee/app). Node.js >= 22.19 and git (the command) are
still required by the installer itself.
EOF
}

DRY_RUN=0
FORWARDED=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    *) FORWARDED+=("$arg") ;;
  esac
done

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
  exit 1
fi
command -v tar >/dev/null 2>&1 || { echo "error: tar is required" >&2; exit 1; }

# --- resolve the archive ---------------------------------------------------
ARCHIVE="${PI_COFFEE_BOOTSTRAP_ARCHIVE:-}"
if [ -z "$ARCHIVE" ]; then
  command -v curl >/dev/null 2>&1 || { echo "error: curl is required to download pi-coffee" >&2; exit 1; }
  latest="$(curl -fsSL --max-time 20 "https://api.github.com/repos/$REPO/releases/latest" || true)"
  ARCHIVE="$(printf '%s' "$latest" | sed -n 's/.*"browser_download_url": *"\([^"]*\.tgz\)".*/\1/p' | head -1)"
  if [ -z "$ARCHIVE" ]; then
    # No usable release (rate limit, or none published yet): build from the current main.
    ARCHIVE="https://github.com/$REPO/archive/refs/heads/main.tar.gz"
    echo "note: no release asset found; using the main branch archive instead."
  fi
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pi-coffee-bootstrap.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "==> fetch $ARCHIVE"
case "$ARCHIVE" in
  http://*|https://*) curl -fsSL --retry 2 -o "$WORK/archive" "$ARCHIVE" ;;
  *) cp "$ARCHIVE" "$WORK/archive" ;;
esac

# A curl | bash installer executes whatever it downloaded. There is no published
# checksum, so verification is opt-in: pin the archive with
# PI_COFFEE_BOOTSTRAP_SHA256 when installing in a controlled environment.
if [ -n "${PI_COFFEE_BOOTSTRAP_SHA256:-}" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$WORK/archive" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$WORK/archive" | awk '{print $1}')"
  else
    echo "error: PI_COFFEE_BOOTSTRAP_SHA256 was set but neither sha256sum nor shasum is available" >&2
    exit 1
  fi
  if [ "$actual" != "$PI_COFFEE_BOOTSTRAP_SHA256" ]; then
    echo "error: archive checksum mismatch" >&2
    echo "  expected $PI_COFFEE_BOOTSTRAP_SHA256" >&2
    echo "  actual   $actual" >&2
    exit 1
  fi
  echo "==> checksum verified"
else
  echo "note: no checksum pinned (set PI_COFFEE_BOOTSTRAP_SHA256 to verify the download)"
fi

tar -xzf "$WORK/archive" -C "$WORK"
TOP="$(cd "$WORK" && ls -1 | grep -v '^archive$' | head -1)"
SRC="$WORK/$TOP"
if [ ! -f "$SRC/install.sh" ]; then
  echo "error: the downloaded archive has no install.sh (looked in $SRC)" >&2
  exit 1
fi

VERSION="$(node -p "require('$SRC/package.json').version" 2>/dev/null || true)"
DEST="$APP_DIR/pi-coffee-${VERSION:-main}"

if [ "$DRY_RUN" = "1" ]; then
  echo "dry run: would install $ARCHIVE into $DEST and run: bash $DEST/install.sh ${FORWARDED[*]:-}"
  exit 0
fi

# --- keep a stable copy ----------------------------------------------------
# Versioned directories leave a running daemon's checkout untouched while a new
# version is unpacked next to it; install.sh refuses to restart one that is busy.
copy_to_dest() {
  mkdir -p "$DEST"
  (cd "$SRC" && tar -cf - .) | (cd "$DEST" && tar -xf -)
}

reusable=0
if [ -n "$VERSION" ] && [ -f "$DEST/install.sh" ] && [ -f "$DEST/package.json" ]; then
  reusable=1
fi

if [ "$reusable" = "1" ]; then
  echo "==> reusing $DEST"
elif [ -d "$DEST" ]; then
  # Either the unversioned `main` snapshot (which must follow main on every run
  # instead of being reused forever) or a half-unpacked copy from a failed run.
  case "$DEST" in
    "$APP_DIR"/*) ;;
    *) echo "error: refusing to replace $DEST (outside $APP_DIR)" >&2; exit 1 ;;
  esac
  echo "==> refreshing $DEST"
  rm -rf "$DEST"
  copy_to_dest
else
  copy_to_dest
  echo "==> unpacked $(printf '%s' "${VERSION:-main}") -> $DEST"
fi

# `curl | bash` leaves stdin as the pipe, so an interactive provider setup would be skipped.
# Reattach the terminal when there is one; scripts and CI keep their non-interactive path.
if [ ! -t 0 ] && ( : < /dev/tty ) 2>/dev/null; then
  exec < /dev/tty
fi

exec bash "$DEST/install.sh" ${FORWARDED[@]+"${FORWARDED[@]}"}
