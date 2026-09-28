<# Remove only this application's current-user login shortcut. #>
$ErrorActionPreference = 'Stop'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Agent Usage Monitor.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath
}
Write-Output 'Agent Usage Monitor login startup disabled. The running monitor is unchanged.'
