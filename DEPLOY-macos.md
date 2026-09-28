# Deploying pi-mcp on macOS (Codex general-manager, topology A)

Everything runs on the Mac: `pi` workers, the pi-mcp daemon, and Codex. All traffic is loopback.

## 0. Prerequisites (on the Mac)

- **Node.js** >= 18 (20.11+ recommended): `node -v`
- **git**: `git --version` (Xcode CLT is enough)
- **pi**, installed and authenticated for the **same macOS user** that runs Codex:
  - `pi --version` works, and `~/.pi/agent/auth.json` exists (e.g. run a quick `pi -p "hi"`).
  - If `pi` lives somewhere unusual, note the absolute path — you can pass it as `PI_MCP_PI_BIN`.
- **codex** on PATH (optional; the desktop app can also be configured manually).

## 1. Transfer the project (from this Linux box, excluding build artifacts)

```bash
rsync -a --exclude node_modules --exclude dist --exclude .git \
  /home/lucas/pi-mcp/ mac:~/pi-mcp/
```

Or make a tarball: `tar --exclude node_modules --exclude dist -czf pi-mcp.tgz pi-mcp`.

## 2. Build + register with Codex

```bash
cd ~/pi-mcp
./install.sh          # npm install + build + copy the Codex skill + `codex mcp add pi`
```

If `codex` is not on PATH, add the server manually to `~/.codex/config.toml`:

```toml
[mcp_servers.pi]
url = "http://127.0.0.1:8787/mcp"
```

The skill is installed to `~/.codex/skills/pi-orchestrator/SKILL.md`.

## 3. Run the daemon

Foreground (quick test):

```bash
cd ~/pi-mcp && ./run.sh
```

As a launchd agent (recommended — starts on login, restarts on crash):

```bash
cd ~/pi-mcp && npm run build          # ensure dist/ is current
./deploy/macos/install-daemon.sh
```

- plist: `~/Library/LaunchAgents/com.pimcp.daemon.plist`
- logs: `~/.pi-mcp/logs/daemon.out.log`, `~/.pi-mcp/logs/daemon.err.log`
- stop: `launchctl bootout gui/$(id -u)/com.pimcp.daemon`

## 4. Verify

```bash
curl -s http://127.0.0.1:8787/internal/health          # {"ok":true,...}
```

Then restart Codex. It should:
1. connect to `pi-mcp` and receive the 大总管 `instructions`,
2. discover the `pi-orchestrator` skill,
3. list the `pi_*` tools.

Smoke test from Codex: ask it to `pi_spawn` a worker that creates a file, then `pi_diff`.

## 5. Configuration (optional)

Set these before starting the daemon (or inside the LaunchAgent's `EnvironmentVariables`):

| Env | Default | Meaning |
|---|---|---|
| `PI_MCP_PORT` | `8787` | HTTP port. |
| `PI_MCP_PI_BIN` | `pi` | Absolute path to the `pi` binary if not on PATH. |
| `PI_MCP_DEFAULT_REPO` | cwd | Default repo when `pi_spawn` omits `repo`. |
| `PI_MCP_WORKSPACE_ROOT` | `~/.pi-mcp/worktrees` | Where worker worktrees are created. |
| `PI_MCP_PROVIDER` / `PI_MCP_MODEL` | `deepseek` / `deepseek-flash` | Worker model. |
| `PI_MCP_MAX_SESSIONS` | `8` | Concurrency cap. |

## 6. Troubleshooting

- **Workers fail to start / auth errors** — run `pi -p "hi"` as the daemon's user. If it fails, the
  daemon can't either. Fix `pi` auth first.
- **`pi` not found under launchd** — launchd has a minimal PATH. Add the directory to `DAEMON_PATH`
  in `deploy/macos/install-daemon.sh`, or set `PI_MCP_PI_BIN=/abs/path/to/pi` in the plist.
- **Codex doesn't see the server** — check `~/.codex/config.toml` has `[mcp_servers.pi] url = ...`,
  and that `curl http://127.0.0.1:8787/internal/health` works.
- **Stale worktree errors** — `cd <repo> && git worktree prune` (the daemon also prunes on spawn).
- **Port already in use** — change `PI_MCP_PORT` and update the Codex URL to match.
