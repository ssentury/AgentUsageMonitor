export function parseJsonLine(line) {
  try {
    const record = JSON.parse(line);
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

export function compactTitle(value) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

export function normalizeTimestamp(value) {
  if (!value) return new Date().toISOString();
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function integerValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

// Rate-limit windows are keyed by length so every provider shares the same labels.
export function windowLabel(minutes) {
  if (minutes === 300) return '5h';
  if (minutes === 10080) return '7d';
  if (!Number.isFinite(minutes) || minutes <= 0) return 'window';
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
