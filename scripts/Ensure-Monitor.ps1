<#
.SYNOPSIS
Ensures that the local Agent Usage Monitor service and taskbar indicator are running.
#>

param([switch]$Open, [switch]$NoTaskbar)

$ErrorActionPreference = 'Stop'
$port = 47831
$baseUrl = "http://127.0.0.1:$port"
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root 'src\server.mjs'
$logRoot = Join-Path $env:LOCALAPPDATA 'AgentUsageMonitor'
$stdoutLog = Join-Path $logRoot 'service.log'
$stderrLog = Join-Path $logRoot 'service-error.log'

function Get-MonitorHealth {
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2
        if ($health.app -eq 'agent-usage-monitor') {
            return $health
        }
    }
    catch {
        return $null
    }
    return $null
}

$health = Get-MonitorHealth
if (-not $health) {
    $node = (Get-Command node -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath $logRoot)) {
        New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    }

    # Some launchers can place both Path and PATH in the Windows process environment.
    # Start-Process imports variables into a case-insensitive dictionary and throws on that duplicate,
    # so normalize the current process environment before starting the hidden monitor service.
    $processPath = [Environment]::GetEnvironmentVariable('Path', [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable('PATH', $null, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable('Path', $processPath, [EnvironmentVariableTarget]::Process)

    Start-Process -FilePath $node `
        -ArgumentList @('--no-warnings', "`"$server`"", '--port', [string]$port) `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog
}

# The HTTP listener opens before the initial scans are complete. Wait for
# the scanners as well so callers never mistake a partial database for readiness.
$deadline = [DateTime]::UtcNow.AddSeconds(90)
while ((-not $health -or $health.state -ne 'watching') -and [DateTime]::UtcNow -lt $deadline) {
    if ($health -and $health.state -eq 'error') {
        break
    }
    Start-Sleep -Milliseconds 250
    $health = Get-MonitorHealth
}

if (-not $health -or $health.state -ne 'watching') {
    $detail = if (Test-Path -LiteralPath $stderrLog) {
        (Get-Content -LiteralPath $stderrLog -Encoding UTF8 -Tail 5) -join ' '
    }
    else {
        'No service error log was created.'
    }
    $state = if ($health) { $health.state } else { 'unreachable' }
    throw "Agent Usage Monitor did not become ready on port $port (state: $state). $detail"
}

if (-not $NoTaskbar) {
    & (Join-Path $PSScriptRoot 'Start-Taskbar.ps1') -Port $port
}

if ($Open) {
    Start-Process "$baseUrl/"
}

[pscustomobject]@{
    running = $true
    url = "$baseUrl/"
    version = $health.version
    state = $health.state
    latest_event_at = $health.counts.latest_event_at
} | ConvertTo-Json -Compress
