import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Exercise the real launch script with simulated Windows processes and health responses.
// These scenarios must never stop or launch a real process.
for (const scenario of ['current', 'legacy', 'changed', 'foreign']) {
  test(`monitor startup: ${scenario}`, { skip: process.platform !== 'win32' }, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-startup-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const dir of ['scripts', 'src', 'config']) fs.mkdirSync(path.join(root, dir));
    fs.copyFileSync(new URL('../scripts/Ensure-Monitor.ps1', import.meta.url), path.join(root, 'scripts', 'Ensure-Monitor.ps1'));
    fs.writeFileSync(path.join(root, 'src', 'server.mjs'), '');
    fs.writeFileSync(path.join(root, 'config', 'rate-card.json'), '{}');
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.2.0"}');
    const harness = path.join(root, 'harness.ps1');
    fs.writeFileSync(harness, `
param($Scenario)
$ErrorActionPreference = 'Stop'
$fixtureRoot = $PSScriptRoot
$env:LOCALAPPDATA = $fixtureRoot
$global:stopped = 0
$global:started = 0
$global:health = [pscustomobject]@{ app = 'agent-usage-monitor'; version = '0.2.0'; state = 'watching'; counts = @{} }
if ($Scenario -in 'legacy', 'foreign') { $global:health.app = 'codex-usage-monitor'; $global:health.version = '0.1.0' }
function Invoke-RestMethod { return $global:health }
function netstat { return '  TCP    127.0.0.1:47831    0.0.0.0:0    LISTENING    4242' }
function Get-CimInstance {
    $serverPath = Join-Path $fixtureRoot 'src\\server.mjs'
    if ($Scenario -eq 'foreign') { $serverPath = 'C:\\unrelated\\server.mjs' }
    $created = [DateTime]::UtcNow.AddHours(1)
    if ($Scenario -eq 'changed') { $created = [DateTime]::UtcNow.AddHours(-1) }
    return [pscustomobject]@{ Name = 'node.exe'; CommandLine = 'node "' + $serverPath + '" --port 47831'; ProcessId = 4242; CreationDate = $created }
}
function Stop-Process { $global:stopped++; $global:health = $null }
function Wait-Process {}
function Start-Process {
    $global:started++
    $global:health = [pscustomobject]@{ app = 'agent-usage-monitor'; version = '0.2.0'; state = 'watching'; counts = @{} }
    return [pscustomobject]@{ HasExited = $false }
}
$failure = $null
try { & (Join-Path $fixtureRoot 'scripts\\Ensure-Monitor.ps1') -NoTaskbar | Out-Null }
catch { $failure = $_.Exception.Message }
[pscustomobject]@{ stopped = $global:stopped; started = $global:started; failure = $failure } | ConvertTo-Json -Compress
`);
    const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness, scenario], { encoding: 'utf8' }));
    if (scenario === 'foreign') {
      assert.match(result.failure, /could not be verified/);
      assert.equal(result.stopped, 0);
      assert.equal(result.started, 0);
    } else {
      assert.equal(result.failure, null);
      const replacements = scenario === 'current' ? 0 : 1;
      assert.equal(result.stopped, replacements);
      assert.equal(result.started, replacements);
    }
  });
}
