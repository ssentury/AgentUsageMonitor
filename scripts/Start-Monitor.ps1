<# Starts the service and taskbar indicator. Use -Open for the browser dashboard. #>
param([switch]$Open)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Ensure-Monitor.ps1') -Open:$Open
