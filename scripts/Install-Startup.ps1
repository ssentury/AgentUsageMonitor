<# Register startup for the current Windows user only. Running again updates the same shortcut. #>
$ErrorActionPreference = 'Stop'
$startupDirectory = [Environment]::GetFolderPath('Startup')
# The former Codex-only monitor used its own shortcut; replace it so both do not start.
$legacyShortcut = Join-Path $startupDirectory 'Codex Usage Monitor.lnk'
if (Test-Path -LiteralPath $legacyShortcut) {
    Remove-Item -LiteralPath $legacyShortcut
    Write-Output "Removed legacy startup shortcut: $legacyShortcut"
}
$shell = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path $startupDirectory 'Agent Usage Monitor.lnk'
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'Ensure-Monitor.ps1') + '"'
$shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Description = 'Agent Usage Monitor service and taskbar indicator'
$shortcut.Save()
Write-Output "Login startup registered: $shortcutPath"
