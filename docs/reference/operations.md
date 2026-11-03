# Operations reference

Installation, deployment, logs, upgrades, state, cleanup, security and troubleshooting. This is the
detail behind the short [README](../../README.md); configuration values live in
[configuration.md](configuration.md).

## Install and start

Without a checkout, the one-line installer fetches the newest release into `~/.pi-coffee/app` and runs
its installer (Node.js ≥ 22.19 is still required; git is only needed by the workers):

```bash
curl -fsSL https://raw.githubusercontent.com/lucasjingcn/pi-coffee/main/scripts/bootstrap.sh | bash
```

The bootstrap keeps a versioned copy under `~/.pi-coffee/app/pi-coffee-<version>` so a running
daemon's checkout is never rewritten mid-upgrade; when it falls back to the `main` archive (no
release published yet) the copy is refreshed on every run. The download is not checksummed by
default — pin it with `PI_COFFEE_BOOTSTRAP_SHA256=<sha256>` when you install in a controlled
environment, or `PI_COFFEE_BOOTSTRAP_ARCHIVE=<path-or-url>` to use a mirror.

From a checkout it is the same installer:

```bash
git clone https://github.com/lucasjingcn/pi-coffee.git
cd pi-coffee
npm run install:local
```

`npm run install:local` works in a macOS/Linux shell or Windows PowerShell, and it:

- refuses to touch a running coordinator, and checks Node.js ≥ 22.19 and git up front with an
  actionable message;
- installs what the copy needs: a checkout runs `npm install` and `npm run build`, while a published
  release tarball (no `src/`, no `tsconfig.json`) installs the runtime dependencies only and uses the
  `dist/` it ships;
- installs the `pi-orchestrator` skill for the Agent Skills clients it finds (`~/.agents/skills`);
- registers the **stdio proxy** as the MCP server `pi` with every MCP client it detects — Codex when
  `codex` is on `PATH`, and the installed pi CLI. The proxy forwards to the HTTP daemon and reconnects
  on its own, so restarting the daemon does not break the session. A missing client is skipped, never
  an install failure: [register-clients.mjs](../../scripts/register-clients.mjs) prints the exact
  command or `mcpServers` snippet for DSH, Claude Code, Cursor and anything else;
- asks for provider, API key and model, and stores them in the user's `~/.pi-coffee/env`. A blank API
  key keeps an existing pi login (`~/.pi/agent/auth.json`); a missing credential is a warning, not a
  failed install — the daemon is still installed and the summary names the follow-up;
- installs and starts a background daemon for the current user at login (LaunchAgent, systemd user
  service or Windows Scheduled Task), then checks its health and prints the endpoint, log locations,
  restart command and next steps.

Scripted installs pass the setup options through:

```bash
npm run install:local -- --provider deepseek --model deepseek-flash --api-key sk-...
```

`--skip-setup` (or `PI_COFFEE_SKIP_SETUP=1`) defers credentials to `npm run setup`; the one-line
installer forwards the same options after `--`.

The installer also installs the pinned pi CLI independently under `~/.local/share/pi-cli`, registers
`pi` in `~/.local/bin`, and configures your shell PATH (Windows: user PATH). Open a new terminal and
run `pi` from any project: it keeps the current directory and uses settings from `~/.pi-coffee/env`;
explicit provider/model options override those defaults. To install or repair only the command
without restarting the daemon, run `npm run install:cli`. The installer keeps a private Node runtime in
the CLI prefix, so removing an installer cache does not break `pi`. On Unix, a supported Node on
`PATH` takes precedence.

Because pi reads provider API keys from the environment, this credential setup means you do **not**
have to run `/login` inside pi. Adjust later with:

```bash
npm run setup     # provider, API key, model, thinking level (writes ~/.pi-coffee/env)
npm run doctor    # preflight: node, git, pi, credentials, data directory
```

For foreground debugging, stop the background daemon and run `npm run start`. Both modes load the
same env file through `scripts/start.mjs`; point it elsewhere with `PI_COFFEE_ENV_FILE`. Check that it
came up with `node scripts/check-health.mjs`, and prove the whole control surface on this machine
without a model call with `npm run demo` (offline smoke: daemon, worktrees, acceptance files, claims,
verify/merge gates, persistence; a few seconds).

Restart your MCP client afterwards: it picks up the orchestration instructions, loads the
`pi-orchestrator` skill, and the `pi_*` tools appear. A new pi session gets the same skill from
`~/.agents/skills` and the same MCP server; other Agent Skills clients load the skill after a reload
or a new session. `npm run doctor` lists which clients are registered and the one command that fixes
each one. On Windows the background process starts when this user signs in; it does not run before
login.

Once the package is published, `npm i -g pi-coffee` (or `npx pi-coffee`) exposes the same commands:
`pi-coffee install`, `setup`, `doctor`, `register-clients`, `start`, `status`, `demo`.

## Connecting clients

Re-register after installing or changing a client (idempotent, and it restores the Codex config when
an add fails):

```bash
node scripts/register-clients.mjs        # or: npm run register:clients
```

For DeepSeek Harness, see [docs/integrations/dsh.md](../integrations/dsh.md). The installer never
writes DSH configuration itself; when `~/.dsh` exists it prints the explicit command:

```bash
node scripts/setup-dsh.mjs --write      # --print shows the snippet without writing
```

For Codex, `npm run install:local` registers the proxy when Codex is installed. For manual repair, add
the server in `~/.codex/config.toml` and restart Codex:

```toml
[mcp_servers.pi]
command = "node"            # an absolute path to node is recommended
args = ["/absolute/path/to/pi-coffee/scripts/proxy.mjs"]
```

For pi, the installer registers the same server; repair or add it manually with:

```bash
pi mcp add pi --description "pi-coffee: spawn, review, verify, and merge isolated pi coding workers" \
  -- /absolute/path/to/node /absolute/path/to/pi-coffee/scripts/proxy.mjs
```

### Client per-tool timeout

`pi_verify` and `pi_exec` run the fixed acceptance command for up to 10 minutes, and `pi_wait` blocks
for its whole window. Most MCP clients cap each tool call at 60 seconds by default, which cuts such a
call off with a transport error. Raise that limit once per client:

```toml
[mcp_servers.pi]
# ...command/args as shown above...
tool_timeout_sec = 600
```

```json
// ~/.pi/agent/mcp.json
{ "mcpServers": { "pi": { "timeout": 600 } } }
```

A client timeout stops nothing: the daemon keeps the wait, the worker keeps working, and no
acceptance result is invalidated. Treat it as "the caller stopped listening", not as a worker
failure, then read the real state with `pi_status` / `pi_list`. `pi_wait` already defaults to a
30-second window, so a 60-second client cap is enough for polling; the raised limit matters for
`pi_verify` and `pi_exec` on slow suites. Neither CLI can set this for you (`codex mcp add` and
`pi mcp add` have no timeout option), so edit the client configuration directly.

### Worker runners

Workers run the pinned pi CLI by default. Set `PI_COFFEE_RUNNER=acp` (or `spec.runner` on one spawn)
to drive any ACP agent over stdio instead; `PI_COFFEE_ACP_COMMAND` (or `spec.runner.command`) is the
agent argv. ACP v1 has no model-selection or transcript-replay contract, so `pi_send` model overrides
are refused and ACP sessions cannot be resumed (spawn a new one); permissions surface as normal
`pi_answer` questions, and raw frames are kept in `sessions/<id>/acp.jsonl` for `pi_tail`. ACP
runners are host-only: the docker sandbox rejects them rather than wrapping an agent it cannot
verify.

### Daemon on another machine

If the repository and the pi credentials live on one host and you only run the MCP client elsewhere,
bind the daemon to the LAN or VPN and set a shared token:

```bash
PI_COFFEE_HOST=0.0.0.0 PI_COFFEE_TOKEN=<secret> ./run.sh
```

On the client machine:

```bash
PI_COFFEE_TOKEN=<secret> codex mcp add pi \
  --url http://<daemon-host>:8787/mcp --bearer-token-env-var PI_COFFEE_TOKEN
```

`pi_diff`, `pi_commit`, `pi_merge` and `pi_push` let the client review and integrate code it cannot
reach directly. Do this only on a network you trust; the default bind is loopback.

## Docker

The included `Dockerfile` bundles Node, git and pi, so the only host requirement is Docker.

```bash
cp .env.example .env       # set your provider API key and model
mkdir -p workspace         # put or clone the repository workers should edit here
docker compose up -d --build
curl http://127.0.0.1:8787/internal/health
```

`./workspace` is mounted at `/workspace` and is the default repo; a named volume holds `/data` (daemon
state). The container reads the same `PI_COFFEE_*` variables and provider key from `.env`.

To connect a client, point it at the container:

```toml
[mcp_servers.pi]
url = "http://127.0.0.1:8787/mcp"

[mcp_servers.pi.env]
PI_COFFEE_TOKEN = "optional-shared-secret"
```

Set `PI_COFFEE_TOKEN` in `.env` too if you want authentication. The port is published on loopback by
default; expose it on `0.0.0.0` only together with a token. The container runs as root so it can write
the `/data` volume and the bind-mounted workspace; for an untrusted repository pass `--user <uid>:<gid>`
and make `/data` writable for that uid (or use separate OS/container isolation).

Workers of a sandboxed daemon (`PI_COFFEE_SANDBOX=docker`) get the repository's git metadata mounted
so `git add`/`git commit` work inside the container, but `<repo>/config` and `<repo>/.git/hooks` are
mounted **read-only**: a writable config lets a container redirect `core.hooksPath` or define a
`filter.*.clean` that the host daemon would then execute during `pi_commit`/`pi_merge`. Consequently
`git config --local …` inside a worker container fails by design — set repository settings on the
host, and use `pi_commit` for commits the daemon should record.

Without Compose:

```bash
docker build -t pi-coffee .
docker run --rm -p 127.0.0.1:8787:8787 \
  -e PI_COFFEE_PROVIDER=deepseek -e PI_COFFEE_MODEL=deepseek-flash \
  -e DEEPSEEK_API_KEY=sk-... \
  -v "$PWD/workspace:/workspace" -v pi-coffee-data:/data \
  pi-coffee
```

Day-to-day:

```bash
docker compose logs -f                                # follow daemon logs
docker compose build --pull && docker compose up -d   # upgrade
docker compose down                                   # stop (state volume is kept)
docker compose down -v                                # stop and drop daemon state
```

## Services and logs

The single install command configures the right background startup for the host.

The daemon writes every diagnostic line to stderr with an ISO-8601 UTC timestamp. Where that lands
depends on the supervisor:

| Install | Where the log goes | Rotation |
|---|---|---|
| macOS (launchd) | `~/.pi-coffee/logs/daemon.err.log` | yes: archived to `daemon.err.log.1` at the next start once it exceeds `PI_COFFEE_LOG_MAX_MB` |
| Linux (systemd) | the journal: `journalctl --user -u pi-coffee -f` | journald keeps its own limits |
| Windows (scheduled task) | `$HOME\.pi-coffee\logs\daemon.log` | no: the task pipes it through `Out-File` |
| Docker / `npm run start` | `docker compose logs -f`, or the terminal | the collector's own limits |

```bash
tail -f ~/.pi-coffee/logs/daemon.err.log                       # macOS
grep -iE "error|fail|refus|timeout|unreach" ~/.pi-coffee/logs/daemon.err.log
journalctl --user -u pi-coffee -f                              # Linux
docker compose logs -f                                          # Docker
```

Rotation is copytruncate: launchd opens the log before the daemon starts and keeps that descriptor, so
renaming the file would send later lines into the archive. It only touches a log the process itself
writes to, which makes it a no-op under systemd, docker and foreground runs. Daemon-side errors
(`mcp error:`, `internal error:`, `[state] ... failed`, `reclaimed N stale credential(s)`) land here.

Other layers keep their own record: pi appends MCP server logging notifications to
`~/.pi/agent/mcp.log`, `/mcp` (or `pi mcp list`) shows connection errors plus the tail of the server's
stderr, and each worker's full transcript is the pi session log under
`PI_COFFEE_DATA_DIR/sessions/<id>/*.jsonl` — read the live view with `pi_tail` or
`pi_status({detail:"full"})`. `node scripts/status.mjs` prints the current workers and locks.

### Linux (systemd user service)

```bash
systemctl --user status pi-coffee
systemctl --user stop pi-coffee
```

### macOS (launchd)

```bash
launchctl print gui/$(id -u)/com.picoffee.daemon
```

Logs go to `~/.pi-coffee/logs/daemon.{out,err}.log`. Stop the agent with
`launchctl bootout gui/$(id -u)/com.picoffee.daemon`. The launch agent sets a `PATH` that includes
Homebrew and `~/.pi/agent/bin` so `pi` and `git` resolve.

### Windows 10+ (current-user login task)

In PowerShell, inspect it with `Get-ScheduledTask -TaskName pi-coffee`; stop it with
`Stop-ScheduledTask -TaskName pi-coffee`. Logs are in `$HOME\.pi-coffee\logs\daemon.log`. The task runs
only after this user logs in. Git for Windows supplies Bash for worker acceptance commands.

### Copying an installation to one Mac

```bash
rsync -a --exclude node_modules --exclude dist ./ mac:~/pi-coffee/
# then, on the Mac:
cd ~/pi-coffee && npm run install:local
```

## Dashboard and metrics

The daemon serves two read-only operator surfaces. When `PI_COFFEE_TOKEN` is set, both require the
same `x-pi-coord-token` / `Authorization: Bearer` credential as `/mcp`.

- `GET /dashboard` — a small read-only console: sessions, status, cost, turns, model, and per-session
  diff/tail. It has no spawn, stop, merge or message actions.
- `GET /metrics` — Prometheus text exposition (`pi_coffee_*`): uptime, active/max workers, drain
  state, session counts by status, spawn/verify/merge totals, and worker-reported USD cost when
  complete. Unknown cost is omitted rather than reported as zero.
- `GET /internal/capabilities` — daemon version, feature list, MCP tool order and internal endpoints
  (used by operators and the worker extension).

The console is read-only by default. `PI_COFFEE_DASHBOARD_ACTIONS=1` (which requires
`PI_COFFEE_TOKEN`) adds audited `send`, `finish`, `merge` and `stop` actions: every POST needs the
token, the `x-pi-coffee-action: 1` CSRF header, a JSON content type and a same-origin origin;
destructive actions also require `x-pi-coffee-confirm: <session id>`. The token is entered in the
browser and kept in that tab's `sessionStorage`; no token is embedded in HTML.

## Upgrade, drain and uninstall

Drain first so running workers are not dropped, then update the checkout and rerun the same
installer (it starts the new build):

```bash
npm run upgrade -- --timeout=300   # drains, then stops the daemon
git pull
npm install
npm run install:local              # re-installs and starts the new build
```

What "stop" means depends on the supervisor, and the script reports which case it applied:

- **launchd (macOS)**: the agent is unloaded (`launchctl bootout`), because `KeepAlive` would
  otherwise restart the *old* build seconds after the graceful exit and the installer would then
  refuse with "pi-coffee is running". `npm run install:local` bootstraps the agent again with the
  new build.
- **systemd (Linux)**: `Restart=on-failure`, so the graceful stop stays stopped; `install:local`
  enables and starts the unit again.
- **scheduled task (Windows)**: the task is not a supervisor for a graceful exit; `install:local`
  starts it again (or `Start-ScheduledTask -TaskName pi-coffee`).
- **foreground (`node scripts/start.mjs`)**: nothing restarts it for you.

The script cancels its drain on every failure. If a run was interrupted, check with
`pi_drain action=status` and release it with `pi_drain action=cancel`, or new spawns and resumes
keep being rejected.

Docker:

```bash
docker compose build --pull && docker compose up -d
```

`pi_drain` (MCP) and `POST /internal/drain` expose the same drain state (`start` / `status` /
`cancel`). To remove the background startup:

```bash
systemctl --user disable --now pi-coffee                         # Linux
rm ~/.config/systemd/user/pi-coffee.service
systemctl --user daemon-reload

launchctl bootout gui/$(id -u)/com.picoffee.daemon               # macOS
rm ~/Library/LaunchAgents/com.picoffee.daemon.plist
```

```powershell
Stop-ScheduledTask -TaskName pi-coffee                            # Windows
Unregister-ScheduledTask -TaskName pi-coffee -Confirm:$false     # Windows
```

Then remove the MCP registration from each client that has one: `codex mcp remove pi` for Codex, and
drop the `pi` entry that `pi mcp list` shows for the pi CLI (DSH, Claude Code and Cursor keep their own
configuration, so remove it there). Removing the installed skill and `~/.pi-coffee` is optional; the
latter deletes local credentials and daemon state, so preserve anything you still need. A one-line
install also keeps its checkout under `~/.pi-coffee/app`, which can be deleted once the service is
gone.

## State and recovery

Each worker snapshots the global pi agent configuration into a private `sessions/<id>/agent`
directory (0700; copied files 0600). Settings and credentials are read with pi's lock protocol and
bounded asynchronous retries. Worker settings/auth/model files are independent; skill, prompt and
theme directories remain linked, and relative extension/skill/prompt/theme/package paths retain their
original targets. Global plugins are inherited only when `PI_COFFEE_WORKER_PLUGINS` allows them:
packages, external extension entries and MCP servers are denied by default, so an interactive-only
extension cannot change worker behavior or let a worker spawn nested sessions. Workers also start
with `--no-skills`, so globally installed skills (including orchestrator policies) cannot steer them;
the task contract comes from the spec and the copied `AGENTS.md`. Core `builtin:` extensions,
credentials and context are never filtered for speed. Changes to global defaults or login credentials
apply to newly spawned workers. A configuration-load error fails startup explicitly instead of
accepting pi's fallback defaults. `/internal/health` identifies this policy as
`private-agent-config-v1` so an old running daemon can be distinguished from a rebuilt one.

Daemon state lives in `state.json` inside `PI_COFFEE_DATA_DIR`. Writes are serialized and atomic: a
unique temp file is renamed into place, and the previous validated snapshot is kept as
`state.json.bak`.

On startup the whole snapshot is validated before any of it is applied. If the primary file is
missing or corrupt, a valid backup is used and a warning goes to stderr. If both are bad, or the
filesystem cannot be read, startup fails instead of quietly starting from scratch. Save failures are
logged; a failed flush during shutdown exits with a non-zero status.

Completed verification is retained as history; a daemon restart invalidates its merge permission.
Reverify the current candidate before integrating. Cost records remain part of the historical task
evidence.

If the daemon crashes instead of stopping cleanly, the next start auto-resumes sessions that were
active at the crash from their existing transcripts, preserving provider/model/thinking and the
control key. Explicitly stopped or finished sessions are not resumed. Set
`PI_COFFEE_RECOVER_ON_START=0` to disable that recovery and resume manually.

The backup can lag the primary by one save, and there is no power-loss durability or multi-daemon
write locking. Run one daemon per state directory.

## Cleanup and retention

A stopped worker keeps everything `pi_resume` needs: the same transcript, worktree, branch, spec and
control key. That is why reclamation is narrow. `pi_gc`, `pi_stop` and the sweeper only remove:

- the **worktree** of a finished worker after `PI_COFFEE_WORKTREE_TTL_MIN`, or of a clean unfinished
  worker after `PI_COFFEE_WORKTREE_FINAL_TTL_MIN` (default 7 days); dirty trees are kept;
- the **transcript** (`PI_COFFEE_DATA_DIR/sessions/<id>`) of a stopped *and* finished session, or of
  an unfinished session whose work is beyond recovery (48h retention lapsed, worktree and worker
  branch gone);
- **branches** only when asked for: `pi_stop` with `delete_branch` (or `PI_COFFEE_DELETE_BRANCHES=1`),
  and `pi_gc` for tips it proves merged into the target.

A session's work is beyond recovery once its worktree is gone and it either already has an outcome or
its worker branch is gone (no committed work left to resurrect). Then the daemon reclaims what it
still holds: the transcript directory under `PI_COFFEE_DATA_DIR/sessions/<id>`, its control credential,
and the bulk in its history entry — acceptance output and the final message keep a tail, contract
free-text and acceptance hashes are dropped, while the review record, outcome, purpose, cost and
token counters stay, so `pi_report` and `pi_metrics` read the same numbers. An unrecorded session with
a live branch is kept, because the branch could still be checked out to continue it. `pi_gc` reports
this as `transcripts_reclaimed`, `credentials_reclaimed` and `history_compacted`; the sweeper does the
same work under `PI_COFFEE_AUTO_CLEAN`.

Never reclaimed automatically: branches with new commits, the transcript and credential of any
session whose worktree or live worker branch is still there (anything that could still be resumed or
checked out), and the daemon's own bookkeeping (mailbox, board and locks). Sessions whose work is
beyond recovery are no longer resumable — dispatch a fresh one instead.

Scoped `pi_gc` acts only on the supplied session IDs. It stops and evicts selected finished workers
and removes clean accepted worktrees, including those left in history by a restart. An abandoned
worktree is also removed when its branch still points at its dispatch base and its files are clean;
unrecorded work, dirty files and abandoned branches with new commits remain available. Then gc
deletes eligible branches whose integration is proven.

A branch is only deleted when its tip is an ancestor of the repository's current `HEAD`. Work
integrated by squash or rebase is not an ancestor, so it is left alone for you to inspect — gc never
force-deletes. Candidates come from persisted metadata, so branches whose worktree is already gone
(for example after a daemon restart) are still eligible. Branches are deduplicated per repo and
branch name.

Nothing is deleted while it is a current or default branch, checked out in any worktree, attached to
an active session, or attached to an existing dirty worktree. Unfinished work and abandoned work with
new commits are kept; an empty abandoned branch can be removed only when no other session shares it
and ancestry proves it safe. These rules apply no matter how `PI_COFFEE_DELETE_BRANCHES` is set.

The result reports `branches_deleted` and a `branches_retained` entry with a reason for every branch
it kept. If git fails on a branch, it is retained and reported, never counted as deleted for you.

## Security

- The daemon binds to loopback and has no authentication by default. Setting `PI_COFFEE_TOKEN`
  enables it: the same secret must be presented on `/mcp` and `/internal/*`, either as
  `x-pi-coord-token` or `Authorization: Bearer <token>`.
- Without a token, the operator endpoints (`/internal/drain`, `/internal/shutdown`) accept a loopback
  caller even once protected sessions exist: with no credential configured nothing could ever
  authorize the upgrade path, and the POST-only rule already stops a web page from using them. Worker
  tokens never reach them.
- Mutating `/internal/*` endpoints only answer POST/PATCH, so a link or cross-site form cannot trigger
  them; oversized bodies get `413`, an unparsable payload `400`.
- If you expose the daemon beyond loopback, use the token and a trusted network or VPN. A token on a
  shared network is not a substitute for network controls.
- File claims are a coordination mechanism, not a sandbox. Treat a worker as able to run arbitrary
  code in its worktree and plan accordingly.

## Failure notices and safe handoff

A worker silent without observable generation progress is not left holding scope forever: the
watchdog warns after `PI_COFFEE_WORKER_WARN_MS` (default 60 seconds), and stops the worker at the
`PI_COFFEE_WORKER_STALL_MS` silence deadline (default 10 minutes), unless a local tool or a pending
question is in flight. Provider failures after retries settle and unexpected worker exits also
produce a durable `handoff` notice. Model quality, model selection and user authorization remain
unchanged; no extra paid retry is launched.

`pi_wait` defaults to a 30-second window. `timedOut:true` and its `wait_hint` describe wait-window
expiry, not worker failure; the wait does not stop workers. Inspect statuses and handoff notices,
then continue waiting for active workers. Keep each window below the script/client/transport deadline
with headroom: with a 60-second outer deadline, use `timeout_ms:30000` and one blocking wait per
codemode script, then re-poll in a new codemode call rather than looping inside one script.
`@options timeout_ms` cannot override an external deadline. Explicit windows up to 120 seconds remain
available for compatible clients. After a transport timeout, inspect scoped `pi_status` / `pi_list`
snapshots instead of blindly stopping or re-spawning workers.

A new notice wakes `pi_wait`, and status/list responses include it. Pass consumed `after_notice_ids`
to avoid replaying a warning. Stateless MCP cannot wake a chat that is no longer executing; its owner
must keep a scoped wait outstanding or read the persisted notice on return. `provider_wait` does not
prove a provider-wide outage.

Only take over when both `safeToTakeOver` and `locksReleased` are true. `stopping` is not a confirmed
exit. Failed shutdown retains locks and blocks writes. POSIX owns a worker process group; Windows
uses native tree termination. Processes escaping that group/tree are outside this guarantee;
advisory coordination is not an OS sandbox.

Delivered reports trigger `awaiting_acceptance`; review and finish read-only work promptly, and use
the existing verification/integration gates for implementation. An idle worker without pending
questions stops after `PI_COFFEE_WORKER_IDLE_MS` (default 30 minutes) with `owner_timeout`, preserving
worktree, branch and report without claiming success.

New worker credentials persist separately in `~/.pi-coffee/control-credentials/` (directory `0700`,
files `0600`), never in status or history. `pi_recover_control` requires the matching scope key. If
both chat capabilities were lost, authorized local administration can use
`node scripts/worker-control.mjs s<N>` (metadata only) or `--stop` (preserve files and branch).
`--show-key` explicitly reveals sensitive credentials; never share them. Pre-upgrade workers with
already-lost credentials have no automatic recovery or keyless MCP bypass.

On restart, new worker PID, start time and group ownership are checked before stopping survivors and
releasing reservations. Missing or mismatched identity, or orphan tools, retain scope and acceptance
locks. Windows crash-orphan recovery retains locks for local administration. Legacy sessions lack this
ownership proof.

## Troubleshooting

| Symptom | Likely cause | What to try |
|---|---|---|
| `{"error":"unauthorized"}` | Token mismatch between daemon and client | Set the same `PI_COFFEE_TOKEN` on the daemon and in the client/proxy environment. |
| `pi_spawn` fails with "repo is required" | No default repository configured | Set `PI_COFFEE_DEFAULT_REPO`, or pass `repo` on every spawn. |
| A worker starts and immediately errors out | Provider credentials are missing or invalid | Run `npm run doctor`, then update them with `npm run setup`. |
| Acceptance commands fail on Windows | Git Bash is unavailable | Install Git for Windows and rerun `npm run doctor`. |
| `git` complains about "dubious ownership" | The daemon user differs from the repo owner | The daemon already passes `safe.directory=*` to its own git calls; if you see this elsewhere, check your git version. |
| Sessions show `stopped` or `error` after a restart | Shutdown confirmed or survivor ownership unresolved | Inspect the handoff; respawn only after safe transfer. Transcript files are preserved. |
| The daemon exits with `EADDRINUSE` | The port is taken | Set `PI_COFFEE_PORT` to a free port (under `docker compose`, set `PI_COFFEE_HOST_PORT` instead: the container always listens on `8787`). |
| `npm run upgrade` says the daemon refused to drain | A previous upgrade left the daemon draining, or the drain started but no worker finished in time | The script cancels the drain on every failure; if it was interrupted, `pi_drain` with `action=cancel`. |
| `codex` is not on `PATH` during install | The installer skipped Codex on purpose instead of failing | Install Codex and run `node scripts/register-clients.mjs`, or connect the client you do have. |
| A client shows no `pi_*` tools | It was installed after the last registration, or it was never restarted | Run `node scripts/register-clients.mjs`, restart the client, then `node scripts/check-health.mjs`. |
| Install ends with "no provider credential yet" | The installer keeps going without a key by design | Run `npm run setup`, then the restart command the summary printed. |
| `npm run demo` fails on a fresh clone | Something else is already listening on the smoke port | It picks a random loopback port; stop the other daemon (or set `SMOKE_PORT`) and rerun. |
| `pi_wait` / `pi_verify` ends in a transport or request timeout | The client's per-tool timeout is shorter than the call | Raise it (`tool_timeout_sec` for Codex, `timeout` for pi) and re-read state with `pi_status`; the worker was never stopped. |
| A worker is blocked by a file claim | Another worker holds a conflicting claim | Use `coord_send` to coordinate, or `pi_release` if the claim is stale. |
