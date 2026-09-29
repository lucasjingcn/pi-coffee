param([Parameter(Mandatory = $true)][string]$NodePath)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'Windows 10 or newer is required.' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path (Join-Path $root 'dist\index.js'))) { throw 'Run npm run build first.' }

$taskName = 'pi-coffee'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
  throw 'pi-coffee is already running. Stop it after workers finish, then rerun npm run install:local.'
}

$runner = Join-Path $root 'deploy\windows\run-task.ps1'
$argument = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -NodePath "{1}"' -f $runner, $NodePath
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument $argument -WorkingDirectory $root
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host 'Installed current-user login task: pi-coffee'
Write-Host 'Logs: ~/.pi-coffee/logs/daemon.log'
Write-Host 'Status: Get-ScheduledTask -TaskName pi-coffee'
Write-Host 'Stop: Stop-ScheduledTask -TaskName pi-coffee'
