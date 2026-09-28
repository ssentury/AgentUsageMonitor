<#
.SYNOPSIS
Builds the taskbar indicator when its sources are newer than the executable, then starts it.
Use -Restart after updating to replace a running indicator.
#>

param([int]$Port = 47831, [switch]$Restart)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root 'taskbar'
$exe = Join-Path $project 'bin\Release\AgentUsageTaskbar.exe'

$sources = Get-ChildItem -LiteralPath $project -File | Where-Object { $_.Extension -in '.cs', '.csproj', '.manifest' }
$newest = ($sources | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
$stale = -not (Test-Path -LiteralPath $exe) -or (Get-Item -LiteralPath $exe).LastWriteTimeUtc -lt $newest

$running = Get-Process -Name 'AgentUsageTaskbar' -ErrorAction SilentlyContinue
if ($running -and ($Restart -or $stale)) {
    # The executable cannot be rebuilt while it is running.
    $running | Stop-Process -Force
    $running | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue
    $running = $null
}

if ($stale) {
    $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
    if (-not $dotnet) {
        throw 'The .NET SDK is required once to build the taskbar indicator (https://dotnet.microsoft.com/download).'
    }
    & $dotnet.Source build (Join-Path $project 'AgentUsageTaskbar.csproj') -c Release -nologo -v quiet | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Taskbar indicator build failed (exit code $LASTEXITCODE). Run 'dotnet build taskbar -c Release' for details."
    }
}

if (-not $running) {
    Start-Process -FilePath $exe -ArgumentList @('--port', [string]$Port, '--root', "`"$root`"")
}
