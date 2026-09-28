<# Stops the taskbar indicator and the verified Agent Usage Monitor process recorded in its PID file. #>
param([switch]$TaskbarOnly)

$ErrorActionPreference = 'Stop'
$taskbar = Get-Process -Name 'AgentUsageTaskbar' -ErrorAction SilentlyContinue
if ($taskbar) {
    $taskbar | Stop-Process -Force
    Write-Output 'Stopped the taskbar indicator.'
}
if ($TaskbarOnly) { exit 0 }

$stateRoot = if ($env:AGENT_USAGE_MONITOR_STATE_ROOT) {
    $env:AGENT_USAGE_MONITOR_STATE_ROOT
}
else {
    Join-Path $env:USERPROFILE '.agent-usage-monitor'
}
$pidPath = Join-Path $stateRoot 'service.pid'

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Output 'Agent Usage Monitor service is not running.'
    exit 0
}

$servicePid = [int](Get-Content -LiteralPath $pidPath -Encoding UTF8 -Raw)
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:47831/api/health' -TimeoutSec 2
if ($health.app -ne 'agent-usage-monitor') {
    throw 'Port 47831 is not owned by Agent Usage Monitor; no process was stopped.'
}
Stop-Process -Id $servicePid -ErrorAction Stop
Write-Output "Stopped Agent Usage Monitor process $servicePid."
