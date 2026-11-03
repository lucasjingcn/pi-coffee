# One customer-facing install path, invoked by `npm run install:local` on Windows 10+.
# A missing MCP client never aborts the install: registration is attempted per client and the
# summary reports what was registered and what is still missing.
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'Windows 10 or newer is required.' }

# Setup options are forwarded: `npm run install:local -- --provider deepseek --api-key sk-...`
$setupArgs = @()
$skipSetup = $env:PI_COFFEE_SKIP_SETUP -eq '1'
foreach ($arg in $args) {
  if ($arg -eq '--skip-setup') { $skipSetup = $true }
  elseif ($arg -eq '--help' -or $arg -eq '-h') {
    Write-Host @'
pi-coffee installer

  npm run install:local [-- <setup options>]

Setup options (forwarded to npm run setup, so they also work non-interactively):
  --provider <name>       Provider id understood by pi (default: deepseek)
  --api-key <key>         Provider API key
  --model <id>            Model id (default: deepseek-flash)
  --thinking <level>      off|minimal|low|medium|high|xhigh|max
  --skip-setup            Do not configure a provider now (npm run setup later)
'@
    exit 0
  }
  else { $setupArgs += $arg }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
$runningTask = Get-ScheduledTask -TaskName 'pi-coffee' -ErrorAction SilentlyContinue
if ($runningTask -and $runningTask.State -eq 'Running') {
  throw 'pi-coffee is running. Stop it after workers finish, then rerun npm run install:local.'
}
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
# Codex is optional: without it the installer still finishes and prints how to connect other clients.
$codexCommand = Get-Command codex.cmd -ErrorAction SilentlyContinue
if (-not $codexCommand) { $codexCommand = Get-Command codex -ErrorAction SilentlyContinue }
$codex = if ($codexCommand) { $codexCommand.Source } else { $null }

& $npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
& $npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$agentsSkillDir = Join-Path $env:USERPROFILE '.agents\skills\pi-orchestrator'
# Codex reads its own directory; pi and other Agent Skills clients read the shared location.
New-Item -ItemType Directory -Path $agentsSkillDir -Force | Out-Null
Copy-Item (Join-Path $root 'codex/pi-orchestrator/SKILL.md') (Join-Path $agentsSkillDir 'SKILL.md') -Force
if ($codex -or (Test-Path $codexHome)) {
  $skillDir = Join-Path $codexHome 'skills\pi-orchestrator'
  New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
  Copy-Item (Join-Path $root 'codex/pi-orchestrator/SKILL.md') (Join-Path $skillDir 'SKILL.md') -Force
}

& $npm run install:cli
if ($LASTEXITCODE -ne 0) { throw 'User pi CLI installation failed.' }

# --- MCP registration ------------------------------------------------------
# One registration path for every platform. scripts/register-clients.mjs detects
# Codex and the pi CLI (writing both idempotently and restoring the Codex config
# when an add fails) and reports how to connect DSH, Claude Code and Cursor.
# Duplicating that here drifted: this installer used to register only Codex and
# pi, with its own weaker rollback, so Windows users never saw the other clients.
Write-Host '==> register MCP server with detected clients'
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $node (Join-Path $root 'scripts\register-clients.mjs')
$registerExit = $LASTEXITCODE
$ErrorActionPreference = $previousErrorAction
$registerFailed = $registerExit -ne 0
if ($registerFailed) {
  Write-Warning 'One MCP client registration failed; its previous configuration was restored.'
}

# --- provider credentials --------------------------------------------------
if ($skipSetup) {
  Write-Host '==> provider setup skipped (--skip-setup / PI_COFFEE_SKIP_SETUP=1)'
} elseif ($setupArgs.Count -gt 0) {
  & $node (Join-Path $root 'scripts\setup.mjs') @setupArgs
  # Exit 2 = "asked for a credential, none given". The install is still usable;
  # the doctor gate below turns it into the single "run npm run setup" follow-up.
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 2) { throw 'Provider setup failed.' }
} elseif (-not [Console]::IsInputRedirected) {
  & $node (Join-Path $root 'scripts\setup.mjs')
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 2) { throw 'Provider setup failed.' }
} else {
  Write-Host '==> provider setup skipped (no terminal). Later: npm run setup, or pass --provider/--api-key'
}

# --- verify ----------------------------------------------------------------
# Redirecting native stderr under ErrorActionPreference=Stop can raise NativeCommandError,
# so the doctor probe runs with 'Continue' and decides on its exit code alone.
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$doctorOutput = (& $node (Join-Path $root 'scripts\doctor.mjs') --background 2>&1 | Out-String)
$doctorExit = $LASTEXITCODE
$ErrorActionPreference = $previousErrorAction
Write-Host $doctorOutput
$setupPending = $false
if ($doctorExit -ne 0) {
  if ($doctorOutput -match '(?m)^FAIL\s+credentials') {
    Write-Warning 'no provider credential yet. The daemon will be installed; run npm run setup.'
    $setupPending = $true
  } else {
    throw 'Preflight failed. Fix the reported requirement and rerun npm run install:local.'
  }
}

& (Join-Path $root 'deploy\windows\install-task.ps1') -NodePath $node
& $node (Join-Path $root 'scripts\check-health.mjs')
if ($LASTEXITCODE -ne 0) {
  Write-Host "  logs:     $env:USERPROFILE\.pi-coffee\logs\daemon.{out,err}.log"
  throw 'Background daemon did not become healthy. Diagnose with npm run doctor.'
}

# Report the port the daemon actually serves, not just the default.
$daemonPort = (& $node --input-type=module -e 'import {loadDaemonEnv} from "./scripts/lib/env.mjs"; loadDaemonEnv(); process.stdout.write(process.env.PI_COFFEE_PORT || "8787");' 2>$null | Out-String).Trim()
if (-not $daemonPort) { $daemonPort = '8787' }

$summary = @"
pi-coffee is installed and running.

  endpoint    http://127.0.0.1:$daemonPort/mcp
  data        $env:USERPROFILE\.pi-coffee
  restart     Stop-ScheduledTask -TaskName pi-coffee; Start-ScheduledTask -TaskName pi-coffee

Next steps
  1. Restart your MCP client; the pi_* tools appear then. Registration results are above.
  2. Check the daemon any time: node scripts/check-health.mjs      (preflight: npm run doctor)
  3. Prove this machine works without spending tokens: npm run demo
  4. First walkthrough: README.md ("Quick start") and docs/reference/operations.md
"@
Write-Host $summary

if ($setupPending) {
  Write-Host @"

! No provider credential is configured yet. Workers cannot start until you do this:

  npm run setup
  Stop-ScheduledTask -TaskName pi-coffee; Start-ScheduledTask -TaskName pi-coffee
"@
}
if ($registerFailed) {
  Write-Host @"

! One MCP client registration failed. Retry it with: node scripts/register-clients.mjs
"@
}
