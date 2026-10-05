# Deploying pi-coffee on macOS (Codex general-manager, topology A)

Everything runs on the Mac: `pi` workers, the pi-coffee daemon, and Codex. All traffic is loopback.

## 0. Prerequisites (on the Mac)

- **Node.js** >= 22.19: `node -v`
- **git**: `git --version` (Xcode CLT is enough)
- **Codex CLI** on PATH for MCP registration.
- A provider API key for setup (or an existing pi authentication file).

## 1. Transfer the project (from this Linux box, excluding build artifacts)

```bash
rsync -a --exclude node_modules --exclude dist --exclude .git \
  /home/lucas/pi-coffee/ mac:~/pi-coffee/
```

Or make a tarball: `tar --exclude node_modules --exclude dist -czf pi-coffee.tgz pi-coffee`.

## 2. Install and start

```bash
cd ~/pi-coffee
npm run install:local
```

The installer builds the app, installs the canonical skill, registers the Codex proxy, configures
the provider, checks the environment, and starts a current-user LaunchAgent. Wait until active
workers finish before reinstalling; the installer will refuse to restart a running coordinator.

- plist: `~/Library/LaunchAgents/com.picoffee.daemon.plist`
- logs: `~/.pi-coffee/logs/daemon.out.log`, `~/.pi-coffee/logs/daemon.err.log` — timestamped lines; a log over `PI_COFFEE_LOG_MAX_MB` (default 5 MB) is archived to `daemon.err.log.1` at the next start
- stop: `launchctl bootout gui/$(id -u)/com.picoffee.daemon`

## 3. Verify

```bash
node scripts/check-health.mjs
```

Then restart Codex. It should:
1. connect to `pi-coffee` and receive the 大总管 `instructions`,
2. discover the `pi-orchestrator` skill,
3. list the `pi_*` tools.

Smoke test from Codex: ask it to `pi_spawn` a worker that creates a file, then `pi_diff`.

## 4. Configuration (optional)

Set these in `~/.pi-coffee/env` before restarting the daemon. `npm run setup` manages provider
credentials and model settings; other keys can be edited in the same file:

| Env | Default | Meaning |
|---|---|---|
| `PI_COFFEE_PORT` | `8787` | HTTP port. |
| `PI_COFFEE_PI_BIN` | pinned local pi | Absolute path to another `pi` CLI, if explicitly needed. |
| `PI_COFFEE_DEFAULT_REPO` | (none) | Default repo when `pi_spawn` omits `repo`; if unset, `repo` is required. |
| `PI_COFFEE_WORKSPACE_ROOT` | `~/.pi-coffee/worktrees` | Where worker worktrees are created. |
| `PI_COFFEE_PROVIDER` / `PI_COFFEE_MODEL` | `deepseek` / `deepseek-flash` | Worker model. |
| `PI_COFFEE_MAX_SESSIONS` | `8` | Concurrency cap. |

## 5. Troubleshooting

- **Workers fail to start / auth errors** — run `npm run doctor` as the daemon's user and check the
  provider credentials in `~/.pi-coffee/env`.
- **Codex doesn't see the server** — check `~/.codex/config.toml` has `[mcp_servers.pi]`,
  and run `node scripts/check-health.mjs`.
- **Stale worktree errors** — `cd <repo> && git worktree prune` (the daemon also prunes on spawn).
- **Port already in use** — change `PI_COFFEE_PORT` in the setup file and restart the daemon;
  the local Codex proxy reads the same file.
