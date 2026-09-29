param([Parameter(Mandatory = $true)][string]$NodePath)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$logDir = Join-Path $env:USERPROFILE '.pi-coffee\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
Set-Location $root
& $NodePath (Join-Path $root 'scripts\start.mjs') 2>&1 | Out-File -FilePath (Join-Path $logDir 'daemon.log') -Append -Encoding utf8
exit $LASTEXITCODE
