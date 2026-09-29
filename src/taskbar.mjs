import { periodStartIso } from './database.mjs';

export const PROVIDER_LABELS = { claude: 'Claude', codex: 'Codex' };
const RATE_WINDOW_SECONDS = 30;
const ACTIVE_SECONDS = 90;
const SCALE_LOOKBACK_MS = 7 * 86_400_000;
const SCALE_REFRESH_MS = 5 * 60_000;
const SCALE_MIN_SAMPLES = 20;
const SCALE_FALLBACK_USD = 0.6;
const PROJECTION_WINDOW_SECONDS = 300;
const PROJECTION_MIN_PERCENT = 3;
const FIVE_HOUR_MS = 5 * 3_600_000;

const scaleCache = new Map();

// Gauge full-scale: the 95th percentile of the user's own busy 30s spend over the last week.
function burnScale(database, id, now) {
  const cached = scaleCache.get(id);
  if (cached && now - cached.at < SCALE_REFRESH_MS) return cached.usd;
  const values = database
    .costBuckets(id, new Date(now - SCALE_LOOKBACK_MS).toISOString(), RATE_WINDOW_SECONDS)
    .filter((usd) => usd > 0)
    .sort((a, b) => a - b);
  const usd = values.length >= SCALE_MIN_SAMPLES ? values[Math.floor((values.length - 1) * 0.95)] : SCALE_FALLBACK_USD;
  scaleCache.set(id, { at: now, usd });
  return usd;
}

// Seconds until the 5h window is exhausted at the recent pace, or null when it cannot be told.
// The API only reports whole percents, so $ per percent is calibrated from local spend in the window.
function projectExhaustSeconds(database, id, fiveHour, now) {
  if (!fiveHour?.resetsAt || fiveHour.usedPercent < PROJECTION_MIN_PERCENT) return null;
  const windowStart = new Date(Date.parse(fiveHour.resetsAt) - FIVE_HOUR_MS).toISOString();
  const windowUsd = database.providerCost(windowStart).get(id)?.usd || 0;
  const recentUsd = database.providerCost(new Date(now - PROJECTION_WINDOW_SECONDS * 1000).toISOString()).get(id)?.usd || 0;
  if (windowUsd <= 0 || recentUsd <= 0) return null;
  const usdPerPercent = windowUsd / fiveHour.usedPercent;
  const rate = recentUsd / PROJECTION_WINDOW_SECONDS;
  return Math.round(((100 - fiveHour.usedPercent) * usdPerPercent) / rate);
}

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
    const fiveHour = limitState.limits?.find((limit) => limit.window === '5h');
    return {
      id,
      label: PROVIDER_LABELS[id],
      // Providers without any usage in 30 days are hidden by the indicator.
      hasUsage: month.has(id),
      active: !!latest && now - Date.parse(latest) < ACTIVE_SECONDS * 1000,
      usdPer30s: recent.get(id)?.usd || 0,
      burnScaleUsd: burnScale(database, id, now),
      exhaustSeconds: projectExhaustSeconds(database, id, fiveHour, now),
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
