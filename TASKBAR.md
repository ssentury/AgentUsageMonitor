# Taskbar indicator

`taskbar/` builds `AgentUsageTaskbar.exe`, a small WinForms (.NET Framework 4.8)
program that embeds a transparent layered window **inside** the Windows taskbar
(`Shell_TrayWnd`). Because it is part of the taskbar, it is never covered by the
taskbar or by other windows the way a floating popup is. Windows 11 only.

`scripts\Start-Taskbar.ps1` rebuilds the executable when any source file is newer,
then starts it. `Ensure-Monitor.ps1` calls it automatically.

## What it shows

One line per agent with usage in the last 30 days:

| Column | Meaning |
| --- | --- |
| `●` | Green while the agent recorded usage in the last 90 seconds |
| `$0.30/30s` | API-equivalent USD over the trailing 30 seconds |
| `오늘 $6.29` | API-equivalent USD since local midnight (`+` = some models have no price) |
| `5h 42%` / `7d 18%` | Plan usage windows; yellow from 60%, red from 80% |
| `CLI 로그인 필요` | Claude plan usage could not be read; run `claude` once in a terminal |

- Hover: details with reset times and model-specific windows (for example `7d Opus`).
- Left click: open the dashboard.
- Right click: dashboard, model prices, rescan, start service, exit indicator.
- When the service is unreachable for five seconds the band shows *서비스 꺼짐*.

The indicator polls `GET /api/taskbar` once per second. Text color follows the
Windows light/dark setting.

## Placement

With centered taskbar icons (the Windows 11 default) the band sits at the left
edge, shifted right when the Widgets button is enabled. With left-aligned icons it
sits just left of the notification area. To override, create
`%USERPROFILE%\.agent-usage-monitor\taskbar.json`:

```json
{ "offsetX": 240 }
```

`offsetX` is in logical pixels from the taskbar's left edge. Restart the indicator
(`Start-Taskbar.ps1 -Restart`) after editing.

If Explorer restarts, the indicator re-attaches within two seconds. Errors are
logged to `%LOCALAPPDATA%\AgentUsageMonitor\taskbar-error.log`.
