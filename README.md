# Agent Usage Monitor

A local usage monitor for **Claude Code** and **Codex** (Desktop and CLI) with a
Windows 11 taskbar indicator. It tracks tokens and estimated API-equivalent cost by
prompt, model, and subagent, and shows plan usage (5-hour / weekly %) right in the
taskbar.

(Originally written by Codex as *Codex Usage Monitor*, now extended by Claude.)

```
● Claude  $0.30/30s  오늘 $6.29  5h 42%  7d 18%
● Codex   $0.00/30s  오늘 $0.27  7d 0%
```

## Quick start

Requires Windows 11 and Node.js 24+. The .NET SDK is needed once to build the
taskbar indicator (it targets .NET Framework 4.8, which ships with Windows).

```powershell
.\scripts\Start-Monitor.ps1 -Open
```

This starts the service, the taskbar indicator, and the dashboard at
`localhost:47831`. No `npm install` is needed. Omit `-Open` to skip the browser.

```powershell
.\scripts\Ensure-Monitor.ps1 -NoTaskbar     # Service only
.\scripts\Start-Taskbar.ps1 -Restart        # Rebuild/restart the indicator after updating
.\scripts\Stop-Monitor.ps1                  # Stop the indicator and the service
.\scripts\Install-Startup.ps1               # Start at Windows login (current user)
```

See [TASKBAR.md](TASKBAR.md) for indicator behavior and placement options.

## Data sources

| Agent | Usage and cost | Plan usage % |
| --- | --- | --- |
| Codex | `%USERPROFILE%\.codex\sessions\**\*.jsonl` | `rate_limits` recorded in the same logs |
| Claude Code | `%USERPROFILE%\.claude\projects\**\*.jsonl` (including subagents) | Claude plan usage endpoint, authenticated with the Claude Code CLI login |

- Source logs are read-only. The database and settings live in
  `%USERPROFILE%\.agent-usage-monitor` (custom prices from the former
  `.codex-usage-monitor` folder are copied on first start).
- Runs on 127.0.0.1 only. The only outbound request is the Claude plan usage query
  to `api.anthropic.com`, which sends the CLI's own OAuth token read from
  `%USERPROFILE%\.claude\.credentials.json`. The token is never refreshed, logged,
  or stored elsewhere.
- **Claude plan usage is an unofficial endpoint** and may change. When the stored CLI
  token has expired (for example if you only use the desktop app), the indicator
  shows *CLI 로그인 필요*; run `claude` once in a terminal and the percentages
  recover automatically.
- The local database contains prompt excerpts and project paths; keep it private.
- Costs use the rate card and reflect recorded usage, not subscription charges.
  Claude Code writes usage when each response completes, so live cost lags slightly.

## Model price settings

Open **Model prices** from the dashboard or the indicator's right-click menu. Model
IDs are filled from recorded usage; enter USD per million tokens. Claude models
bundle separate 5-minute and 1-hour cache-write prices, and dated IDs such as
`claude-haiku-4-5-20251001` use their alias's prices. Blank prices are unknown,
not zero. Codex credits use 25 credits per USD.

Custom prices live in `price-overrides.json` in the state directory. Saving
recalculates historical usage. Export/Import shares prices only.

## Development

Run `npm test`. After updating, run `.\scripts\Start-Monitor.ps1` again (restarting the
service) and `.\scripts\Start-Taskbar.ps1 -Restart`.

## License and credits

MIT. This project grew out of earlier use of Codex Usage Tracker by Douglas Monsky. Its MIT notice and provenance details are preserved in THIRD_PARTY_NOTICES.md.

Unofficial community tool; not affiliated with OpenAI or Anthropic.
