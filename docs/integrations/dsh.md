# Connecting DeepSeek Harness (DSH) to pi-coffee

DeepSeek Harness (DSH) is an MCP client: it can mount the pi-coffee daemon as one MCP server
and expose every `pi_*` tool to the model as `mcp__pi-coffee__<tool>` (for example
`mcp__pi-coffee__pi_spawn`). This guide covers the two supported ways to connect — the daemon's
HTTP endpoint and the stdio proxy — plus a delegation policy for `AGENTS.md`, verification
commands, and the failures people actually hit.

Everything here uses commands that exist in this repository (`node scripts/setup-dsh.mjs`,
`node scripts/check-health.mjs`, `node scripts/proxy.mjs`) and DSH's own documented configuration
conventions (`$DSH_HOME`, the `cordis.patch.yml` patch layer, `@deepseek-ai/dsh-mcp-client`).
Nothing in this repository installs, patches, or writes DSH's global state except the explicit
`--write` invocation described below.

- [How the daemon is started](#how-the-daemon-is-started)
- [The two transports](#the-two-transports)
- [Register pi-coffee in DSH](#register-pi-coffee-in-dsh)
- [Environment variables](#environment-variables)
- [Delegation policy for AGENTS.md](#delegation-policy-for-agentsmd)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)

## How the daemon is started

The MCP server is the pi-coffee daemon itself; DSH is only a client of it, so the daemon has to be
running before a DSH session can use `pi_*` tools.

```bash
npm run install:local     # build, install the pi-orchestrator skill, register Codex/pi, start the
                          # background service, then health-check it
npm run start             # foreground alternative, same env file, Ctrl-C to stop
```

Both paths run `scripts/start.mjs`, which loads the private env file (`~/.pi-coffee/env`, or
`PI_COFFEE_ENV_FILE`) with the file taking precedence, resolves the `pi` and `bash` binaries, and
then imports `dist/index.js`. The daemon binds `PI_COFFEE_HOST:PI_COFFEE_PORT`
(default `127.0.0.1:8787`) and serves two things from that one port:

| Route | Purpose |
| --- | --- |
| `POST /mcp` | Streamable-HTTP MCP endpoint. Stateless: every request builds a fresh MCP server, so a daemon restart never invalidates a client session. `GET`/`DELETE` answer `405`. |
| `/internal/*` | Coordinator API used by workers and scripts (`/internal/health`, `/internal/sessions`, …). |

If `PI_COFFEE_TOKEN` is non-empty, both routes require it, supplied either as the
`x-pi-coord-token` header or as `Authorization: Bearer <token>`; unauthenticated requests get
`401 {"error":"unauthorized"}`. With an empty token (the default install) the daemon is open on
loopback only.

## The two transports

### HTTP MCP endpoint (default)

Point the client straight at `http://127.0.0.1:8787/mcp`. The port is whatever the daemon
resolves — `PI_COFFEE_PORT` in the environment or in `~/.pi-coffee/env`, default `8787`. There is no
extra process and no local binary to keep on `PATH`; the client is connected only while the daemon
runs.

### stdio proxy (alternative)

`scripts/proxy.mjs` is a stdio↔HTTP bridge: the client spawns it as a stdio MCP server, and it
forwards every JSON-RPC message to the daemon's `/mcp` endpoint. It reads the same env file as the
daemon (`PI_COFFEE_URL`, else `PI_COFFEE_PORT`, plus `PI_COFFEE_TOKEN`) and reconnects on its own,
which is why the installer registers this form with Codex and with the pi CLI: restarting the
daemon does not break the client session.

```bash
node /absolute/path/to/pi-coffee/scripts/proxy.mjs
```

### Which one to choose

| | HTTP | stdio proxy |
| --- | --- | --- |
| Daemon restarts | Client reconnects on the next request (endpoint is stateless) | Proxy reconnects internally, session survives |
| Daemon down at client start | Server simply has no tools until it is up | Proxy process starts, calls fail until the daemon is up |
| Remote/container daemon | Yes — set the URL, add the token header | Needs `PI_COFFEE_URL` in the proxy's environment |
| Requirements in the client | Nothing beyond the URL | An absolute `node` path and an absolute path to `scripts/proxy.mjs` |

Use HTTP for a local daemon; use the proxy when the client cannot reach the URL directly or when you
want the connection to outlive daemon restarts without client-side reconnection.

## Register pi-coffee in DSH

DSH composes its plugin tree from patch layers. The user's own layer is
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`$DSH_HOME` defaults to `~/.dsh`; the shipped
desktop profile is `desktop`). It is a top-level YAML array of loader patch entries. Inserting a
`@deepseek-ai/dsh-mcp-client` row there registers one MCP server; the plugin ships with the DSH
installation, so nothing needs to be installed.

### Generate the row with the helper script

```bash
node scripts/setup-dsh.mjs --print                      # JSON MCP config object on stdout
node scripts/setup-dsh.mjs --print --format yaml        # the DSH patch row, ready to paste
node scripts/setup-dsh.mjs --print --transport stdio    # proxy command instead of the HTTP URL
node scripts/setup-dsh.mjs --write                      # merge into the default profile layer
node scripts/setup-dsh.mjs --write --profile headless   # a different DSH profile
node scripts/setup-dsh.mjs --write --config /tmp/mcp.json
node scripts/setup-dsh.mjs --help
```

`--write` merges idempotently: running it twice leaves the file unchanged, unrelated rows and
servers are preserved, and a file it cannot parse is refused (exit `1`) without being touched.
`.yml`/`.yaml` targets are merged as the YAML patch layer; `.json` targets are merged as JSON,
either a DSH patch list (array) or a portable `{ "mcpServers": { … } }` object. Exit codes: `0` ok,
`1` refused/failed write, `2` bad usage.

The script never writes or prints the shared secret. When `PI_COFFEE_TOKEN` is set it emits a
reference instead: `!!js process.env.PI_COFFEE_TOKEN` in YAML, `${PI_COFFEE_TOKEN}` in JSON.

### The row it generates (HTTP)

Append to `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-pi-coffee
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: pi-coffee
        transport: streamable-http
        url: http://127.0.0.1:8787/mcp
        toolCallTimeoutMs: 900000
```

If the daemon requires a token, add the header by expression — never paste the secret:

```yaml
        headers:
          x-pi-coord-token: !!js process.env.PI_COFFEE_TOKEN
```

### The row it generates (stdio proxy)

```yaml
- insert:
    - id: mcp-pi-coffee
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: pi-coffee
        transport: stdio
        command: '/absolute/path/to/node'
        args:
          - '/absolute/path/to/pi-coffee/scripts/proxy.mjs'
        toolCallTimeoutMs: 900000
```

`node scripts/setup-dsh.mjs --print --transport stdio` fills in the absolute `node` and proxy paths
for the machine it runs on.

### Field notes

| Field | Why this value |
| --- | --- |
| `serverName: pi-coffee` | Namespace for the tools (`mcp__pi-coffee__pi_spawn`) and for the connection's presence in the model's tool list. Must be unique per registration scope and match `[A-Za-z0-9_-]{1,32}`. |
| `transport: streamable-http` / `stdio` | Matches the transport chosen above. The daemon's `/mcp` is Streamable HTTP, not legacy SSE. |
| `toolCallTimeoutMs: 900000` | DSH's per-call cap defaults to `60000`. `pi_verify` and `pi_exec` run the acceptance command for up to 10 minutes and `pi_wait` blocks for its whole window, so a 60-second cap ends those calls with a transport error. A client timeout stops nothing — the daemon keeps waiting and the worker keeps working — but the response is lost, so raise the cap and/or keep `pi_wait` windows short and re-poll. |
| `failOnStartupError` (left at its default `false`) | A stopped daemon must not block DSH startup; tools are simply absent until it is running. |
| `id: mcp-pi-coffee` | Keep exactly one row with this id. Re-apply settings by editing it, not by inserting a second one. |

Two more DSH behaviours matter here:

- **The row is loaded at boot, not hot.** Editing `cordis.patch.yml` while DSH runs does not mount a
  newly inserted row: after `--write`, quit and restart DeepSeek Harness before expecting
  `mcp__pi-coffee__*` tools.
- **`!!js` is the way to move secrets into a row.** DSH scrubs ambient credentials, and `!!js`
  expressions are evaluated when the entry activates, so `!!js process.env.PI_COFFEE_TOKEN` reads the
  token from the environment at that point. Because `scripts/proxy.mjs` and the daemon both load
  `~/.pi-coffee/env`, the value can also live there and never enter DSH's config at all.

### One-shot alternative for headless runs

For a single run, DSH's launcher also accepts an extra patch layer, so a scratch file can register the
server without touching the profile:

```bash
dsh --profile headless --patch /tmp/pi-coffee-row.yml --json "list your available tools"
```

`/tmp/pi-coffee-row.yml` is the same `- insert: …` row shown above (a JSON file with the same
structure parses as well, because the entry list is read as YAML/JSON).

## Environment variables

The daemon, the proxy, and the setup script agree on these. `~/.pi-coffee/env` (override the path
with `PI_COFFEE_ENV_FILE`) is loaded by `scripts/start.mjs`, `scripts/proxy.mjs`,
`scripts/check-health.mjs`, `scripts/status.mjs`, `scripts/inspect.mjs`, `scripts/doctor.mjs`,
`scripts/upgrade.mjs` and `scripts/setup-dsh.mjs`, all with the same precedence: an exported
`PI_COFFEE_*` wins and the file only fills the gaps. Two copies of one key with different values
therefore cannot make the proxy talk to a different daemon than the launcher started.

| Variable | Used by | Meaning |
| --- | --- | --- |
| `PI_COFFEE_HOST` | daemon | Bind host, default `127.0.0.1`. |
| `PI_COFFEE_PORT` | daemon, proxy, health check, setup script | MCP + internal API port, default `8787`. Changing it invalidates every row URL that hard-codes the old port. |
| `PI_COFFEE_TOKEN` | daemon, proxy, setup script | Optional shared secret for `/mcp` and `/internal/*`; empty means no authentication. Sent as `x-pi-coord-token` or `Authorization: Bearer`. Never write its value into a DSH row. |
| `PI_COFFEE_URL` | proxy | Full MCP URL; overrides `PI_COFFEE_PORT` (default `http://127.0.0.1:8787/mcp`). |
| `PI_COFFEE_ENV_FILE` | scripts | Path to the env file instead of `~/.pi-coffee/env`. |
| `PI_COFFEE_DATA_DIR` | daemon, scripts | Daemon state directory, default `~/.pi-coffee`. |
| `DSH_HOME` | DSH, setup script | DSH home, default `~/.dsh`. `--write` resolves the default target as `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. |
| `DSH_AGENTS_HOME` | DSH | Shared agents root, default `~/.agents`; DSH reads `AGENTS.md` and `skills/` from it. |

Provider credentials (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, …) belong in the env file as well —
see `.env.example` and `npm run setup`. Workers inherit them from the daemon; DSH does not need them.

## Delegation policy for AGENTS.md

DSH reads an instruction chain: `$DSH_HOME/AGENTS.md`, then `<agentsHome>/AGENTS.md`
(`DSH_AGENTS_HOME`, default `~/.agents`), then the project chain from the repository root down to the
session working directory. DSH also loads skills from `<dshHome>/skills`, `<agentsHome>/skills`, and
the project's `.agents/skills` — so `npm run install:local`, which installs
`~/.agents/skills/pi-orchestrator/SKILL.md`, is already visible to DSH as the `pi-orchestrator` skill.

Add a short delegation policy to `~/.dsh/AGENTS.md` (user-global) or to a repository's `AGENTS.md`
(project-scoped). Keep it a pointer to the authoritative skill rather than a copy:

```markdown
## pi-coffee delegation

The pi-coffee MCP server (`mcp__pi-coffee__*`) runs isolated pi workers in git worktrees.
Read the `pi-orchestrator` skill before the first `mcp__pi-coffee__` call in a session; it is the
authoritative policy for spawning, waiting, reviewing, verifying, and merging.

- Delegate only independent work with a written scope and objective acceptance, and only when the
  expected benefit exceeds specification + waiting + review + integration. Complete small or
  tightly coupled changes directly.
- Split independent slices with non-overlapping file scopes and fixed interfaces, then spawn them
  concurrently before the first wait returns.
- Never spend more than the user's stated budget, never commit, push, deploy, or send external
  messages on the strength of a tool's availability, and never lower model quality to make work
  cheaper.
- Keep worker control keys in this chat; never put them in a prompt, report, or commit.
- Treat a client-side timeout as "the caller stopped listening": re-read state with
  `mcp__pi-coffee__pi_status` / `mcp__pi-coffee__pi_list` instead of re-spawning, and verify a
  candidate before merging it.
```

If your DSH build does not surface the skill, paste the body of
`codex/pi-orchestrator/SKILL.md` into the same `AGENTS.md` section instead of the pointer.

## Verification

```bash
# 1. The daemon is healthy (reads the env file, prints the MCP URL it expects).
node scripts/check-health.mjs
#    -> pi-coffee is healthy at http://127.0.0.1:8787/mcp

# 2. Direct HTTP check, with the token header only if you set one.
curl -s http://127.0.0.1:8787/internal/health
#    -> {"ok":true,"sessions":0,"workerStartupPolicy":...}
curl -s -H "x-pi-coord-token: $PI_COFFEE_TOKEN" http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
#    -> {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}} — the pi_* tool set

# 3. What the setup script would register right now.
node scripts/setup-dsh.mjs --print
```

Then, inside DSH, call the listing tool and confirm the daemon answers through the bridge:

```
mcp__pi-coffee__pi_list           -> {"sessions": []} on an idle daemon, or the worker records
mcp__pi-coffee__pi_status         -> status of one session
```

An empty `sessions` array is the success signal: the tool ran, the daemon answered, and the client
is authenticated. A `401`, a transport error, or a missing `mcp__pi-coffee__*` tool means the
registration or the daemon state is wrong — see below. `npm run doctor` covers the local
prerequisites (Node ≥ 22.19, git, pi binary, credentials, data directory) if the daemon itself
fails to start.

## Troubleshooting

**The tools are not in the model's list.** DSH reads the profile patch layer at boot. After
`--write` (or a manual edit), quit DeepSeek Harness completely and reopen it — a reload is not
enough for an inserted row. Also confirm the row landed in the profile you actually launch:
`node scripts/setup-dsh.mjs --print --format yaml` shows the row, and `--profile <name>` / `--config
<path>` target a different file than the default. Two rows with `id: mcp-pi-coffee` (or two rows with
`serverName: pi-coffee`) is also a misconfiguration; keep one.

**`401 {"error":"unauthorized"}` from `/mcp`.** The daemon has a token and the row does not send it,
or it sends a different one. Check that `PI_COFFEE_TOKEN` in `~/.pi-coffee/env` is the value the row
references, and that the header is spelled `x-pi-coord-token` (or `Authorization: Bearer <token>`).
Remember that `scripts/setup-dsh.mjs` only *references* the variable — it never copies the value into
the config, so an unset variable in DSH's environment yields a literal-looking empty header.

**Connection refused / `fetch failed` / the server shows as unhealthy.** The daemon is not running on
the port the row names. Run `node scripts/check-health.mjs`; if it reports a different port than the
row, `PI_COFFEE_PORT` changed (usually in `~/.pi-coffee/env`) — either fix the variable or re-run
`node scripts/setup-dsh.mjs --write` so the managed block carries the current URL. A daemon started
in the foreground with `npm run start` dies with its terminal.

**A tool call dies at about 60 seconds.** That is DSH's per-call default, not a worker failure. Set
`toolCallTimeoutMs: 900000` on the row and keep individual `pi_wait` windows short (its default is
30 s) while polling. The daemon keeps executing regardless; re-read `pi_status` / `pi_list` rather
than re-spawning.

**stdio proxy fails to start, or `node`/`ENOENT` errors in the DSH log.** GUI applications do not
inherit your shell `PATH`, so `command: node` may not resolve and `~/.local/bin` is usually absent.
Use absolute paths — `node scripts/setup-dsh.mjs --print --transport stdio` prints the `node` that is
running the script and the absolute proxy path. Keep the proxy inside the checkout (it imports
`./lib/env.mjs` and `../dist/stdio-proxy.js`, so the repository must be built:
`npm run build`). If the daemon lives elsewhere or listens on another port, set `PI_COFFEE_URL` in
the proxy's environment instead of editing the row's URL.

**Tools appear but every call fails immediately after a daemon upgrade.** Refresh the connection
(restart DSH) so the client re-reads `tools/list`; a client that cached older declarations cannot
send newly required arguments, and the daemon will reject the call rather than guess.

**Everything looks right but only *some* `pi_*` tools exist.** The daemon exposes the tool set of the
build it is running. Restart it with the current checkout (`npm run start`, or reinstall the
background service) and re-check with `curl … tools/list`.
