import { periodStartIso } from './database.mjs';

export const PROVIDER_LABELS = { claude: 'Claude', codex: 'Codex' };
const RATE_WINDOW_SECONDS = 30;
const ACTIVE_SECONDS = 90;

// Compact per-provider state for the Windows taskbar indicator (polled every second).
export function taskbarSnapshot(database, claudeLimits, now = Date.now()) {
  const recent = database.providerCost(new Date(now - RATE_WINDOW_SECONDS * 1000).toISOString());
  const today = database.providerCost(periodStartIso('today'));
  const month = database.providerCost(new Date(now - 30 * 86_400_000).toISOString());

  const providers = Object.keys(PROVIDER_LABELS).map((id) => {
    const latest = today.get(id)?.latestEventAt || month.get(id)?.latestEventAt || null;
    const limitState = id === 'claude'
      ? claudeLimits
      : { status: 'ok', message: null, limits: codexLimits(database, now) };
    return {
      id,
      label: PROVIDER_LABELS[id],
      // Providers without any usage in 30 days are hidden by the indicator.
      hasUsage: month.has(id),
      active: !!latest && now - Date.parse(latest) < ACTIVE_SECONDS * 1000,
      usdPer30s: recent.get(id)?.usd || 0,
      todayUsd: today.get(id)?.usd || 0,
      unpriced: (today.get(id)?.unpricedCalls || 0) > 0,
      latestEventAt: latest,
      limitStatus: limitState.status,
      limitMessage: limitState.message,
      limits: limitState.limits,
    };
  });
  return { at: new Date(now).toISOString(), rateWindowSeconds: RATE_WINDOW_SECONDS, providers };
}

function codexLimits(database, now) {
  return database.rateLimits('codex').map((row) => {
    const expired = row.resetsAt && Date.parse(row.resetsAt) <= now;
    // After the reset time the window restarts; any new use would log a fresh value.
    return { window: row.windowKey, usedPercent: expired ? 0 : row.usedPercent, windowMinutes: row.windowMinutes, resetsAt: expired ? null : row.resetsAt };
  });
}
