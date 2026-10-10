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
$expectedVersion = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

function Get-MonitorHealth {
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2
        return $health
    }
    catch {
        return $null
    }
    return $null
}

function Get-MonitorProcess {
    # Verify both the listening PID and this checkout's exact server path before stopping anything.
    $listener = netstat -ano -p tcp | Where-Object {
        $fields = $_.Trim() -split '\s+'
        $fields.Count -eq 5 -and $fields[1] -eq "127.0.0.1:$port" -and $fields[3] -eq 'LISTENING'
    } | Select-Object -First 1
    if (-not $listener) { return $null }
    $listenerPid = [int](($listener.Trim() -split '\s+')[-1])
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerPid"
    $serverPattern = '(?:^|\s)"?' + [regex]::Escape($server) + '"?(?:\s|$)'
    if ($process.Name -eq 'node.exe' -and $process.CommandLine -match $serverPattern) { return $process }
    return $null
}

$health = Get-MonitorHealth
if ($health) {
    if ($health.app -notin 'agent-usage-monitor', 'codex-usage-monitor') {
        throw "Port $port is owned by another application; no process was stopped."
    }
    $serviceProcess = Get-MonitorProcess
    $runtimeFiles = @(Get-ChildItem -LiteralPath (Join-Path $root 'src') -Recurse -File -Filter '*.mjs')
    $runtimeFiles += Get-Item -LiteralPath (Join-Path $root 'config\rate-card.json')
    $latestRuntime = ($runtimeFiles | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
    $outdated = $health.app -ne 'agent-usage-monitor' -or $health.version -ne $expectedVersion -or
        ($serviceProcess -and $serviceProcess.CreationDate.ToUniversalTime() -lt $latestRuntime)
    if ($outdated) {
        if (-not $serviceProcess) {
            throw "Port $port has an outdated monitor, but its process could not be verified; no process was stopped."
        }
        Stop-Process -Id $serviceProcess.ProcessId -ErrorAction Stop
        Wait-Process -Id $serviceProcess.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
        $health = $null
    }
}
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

    $startedProcess = Start-Process -FilePath $node `
        -ArgumentList @('--no-warnings', "`"$server`"", '--port', [string]$port) `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -PassThru
}

# The HTTP listener opens before the initial scans are complete. Wait for
# the scanners as well so callers never mistake a partial database for readiness.
$deadline = [DateTime]::UtcNow.AddSeconds(90)
while ((-not $health -or $health.state -ne 'watching') -and [DateTime]::UtcNow -lt $deadline) {
    if ($startedProcess -and $startedProcess.HasExited) { break }
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
