# Keep the bridge up without thinking about it.
#
# "Reachable as long as the PC is on" is only true if something starts the
# bridge when the PC starts. This registers a Scheduled Task that runs it at
# boot and at logon, with no window, and starts it straight away.
#
# From an Administrator PowerShell, in any folder:
#
#   powershell -ExecutionPolicy Bypass -File "<this repo>\bridge\run-at-logon.ps1"
#   powershell -ExecutionPolicy Bypass -File "<this repo>\bridge\run-at-logon.ps1" -Remove
#
# Run it yourself when you are ready — nothing here runs on its own. It needs
# bridge\.env to exist, because the task starts the bridge with no arguments.
#
# Why "run whether you are logged on or not": a task that runs as you
# interactively owns a console, and on Windows 11 that console is a Terminal
# window. Close it and the phone stops getting answers. Running it this way
# (S4U — no password is stored) means there is no window to close, and that
# it is up after a Windows Update reboot before anyone has signed in. The one
# thing it cannot do is show anything on your screen or read Credential
# Manager; an assistant that needs either is better reached by ASSISTANT_URL.
#
# The task runs keep-up.mjs, which runs the bridge and starts it again if it
# ever stops, and writes what it prints to bridge\bridge.log.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$TaskName = 'claude-remote assistant bridge'
$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo     = Split-Path -Parent $here
$keeper   = Join-Path $here 'keep-up.mjs'
$log      = Join-Path $here 'bridge.log'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

# A task that is running keeps its old process — and its old window — when
# it is replaced or removed, unless it is stopped first.
if ($existing -and $existing.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $TaskName
}

if ($Remove) {
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Stopped and removed the task. The bridge will not start on its own any more."
  } else {
    Write-Host "There was no task to remove."
  }
  return
}

$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = (New-Object Security.Principal.WindowsPrincipal $me).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  throw "Run this from an Administrator PowerShell: a task with no window, that starts at boot, needs it."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node is not on PATH. Install Node 18 or newer first." }
if (-not (Test-Path $keeper)) { throw "Cannot find $keeper" }
if (-not (Test-Path (Join-Path $here '.env'))) {
  Write-Warning "There is no bridge\.env yet, so the bridge will start and exit."
  Write-Warning "Run npm run bridge:setup first."
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$keeper`"" -WorkingDirectory $repo
$triggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -AtLogOn -User $me.Name)
)
$principal = New-ScheduledTaskPrincipal -UserId $me.Name -LogonType S4U -RunLevel Limited
# Restarting here covers the task failing to launch at all; keep-up.mjs
# covers the bridge stopping once it is running.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
  -Principal $principal -Settings $settings `
  -Description 'Answers messages sent from the claude-remote dashboard.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$state = (Get-ScheduledTask -TaskName $TaskName).State

Write-Host "Registered `"$TaskName`" and started it: $state."
Write-Host "It runs at boot and at logon with no window, and starts the bridge again if it stops."
Write-Host ""
Write-Host "What it is doing:  Get-Content -Encoding UTF8 -Tail 20 -Wait `"$log`""
Write-Host "Undo:              powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Remove"
