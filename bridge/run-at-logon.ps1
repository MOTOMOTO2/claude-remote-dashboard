# Keep the bridge up without thinking about it.
#
# "Reachable as long as the PC is on" is only true if something starts the
# bridge when the PC starts. This registers a Scheduled Task that runs it at
# logon, restarts it if it ever stops, and keeps no console window open.
#
#   powershell -ExecutionPolicy Bypass -File bridge\run-at-logon.ps1
#   powershell -ExecutionPolicy Bypass -File bridge\run-at-logon.ps1 -Remove
#
# Run it yourself when you are ready — nothing here runs on its own. It needs
# bridge\.env to exist, because the task starts the bridge with no arguments.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$TaskName = 'claude-remote assistant bridge'
$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo     = Split-Path -Parent $here
$script   = Join-Path $here 'bridge.mjs'

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed the task. The bridge will not start at logon any more."
  } else {
    Write-Host "There was no task to remove."
  }
  return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node is not on PATH. Install Node 18 or newer first." }
if (-not (Test-Path $script)) { throw "Cannot find $script" }
if (-not (Test-Path (Join-Path $here '.env'))) {
  Write-Warning "There is no bridge\.env yet, so the task will start and exit."
  Write-Warning "Copy bridge\.env.example to bridge\.env and fill it in first."
}

# Start-Process with a hidden window, because a task that owns a console
# puts a black box on screen at every logon.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Answers messages sent from the claude-remote dashboard.' `
  -Force | Out-Null

Write-Host "Registered `"$TaskName`"."
Write-Host "It starts at logon and restarts itself if it stops."
Write-Host ""
Write-Host "Start it now:   Start-ScheduledTask -TaskName `"$TaskName`""
Write-Host "Check on it:    Get-ScheduledTask -TaskName `"$TaskName`" | Get-ScheduledTaskInfo"
Write-Host "Undo:           powershell -File bridge\run-at-logon.ps1 -Remove"
