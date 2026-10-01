# One customer-facing install path, invoked by `npm run install:local` on Windows 10+.
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'Windows 10 or newer is required.' }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
$runningTask = Get-ScheduledTask -TaskName 'pi-coffee' -ErrorAction SilentlyContinue
if ($runningTask -and $runningTask.State -eq 'Running') {
  throw 'pi-coffee is running. Stop it after workers finish, then rerun npm run install:local.'
}
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$codexCommand = Get-Command codex.cmd -ErrorAction SilentlyContinue
if (-not $codexCommand) { $codexCommand = Get-Command codex -ErrorAction Stop }
$codex = $codexCommand.Source

& $npm install
if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
& $npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

& $npm run install:cli
if ($LASTEXITCODE -ne 0) { throw 'User pi CLI installation failed.' }

if (-not $env:PI_COFFEE_SKIP_SETUP -and -not [Console]::IsInputRedirected) {
  & $node (Join-Path $root 'scripts\setup.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Provider setup failed.' }
}
& $node (Join-Path $root 'scripts\doctor.mjs') --background
if ($LASTEXITCODE -ne 0) { throw 'Preflight failed. Fix the reported requirement and rerun npm run install:local.' }

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$skillDir = Join-Path $codexHome 'skills\pi-orchestrator'
New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
Copy-Item (Join-Path $root 'codex/pi-orchestrator/SKILL.md') (Join-Path $skillDir 'SKILL.md') -Force

$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { & $codex mcp remove pi 2>$null | Out-Null }
finally { $ErrorActionPreference = $previousErrorAction }
& $codex mcp add pi -- $node (Join-Path $root 'scripts\proxy.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed.' }

& (Join-Path $root 'deploy\windows\install-task.ps1') -NodePath $node
& $node (Join-Path $root 'scripts\check-health.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Background daemon did not become healthy.' }
Write-Host 'Done. Restart Codex to load the pi_* tools.'
