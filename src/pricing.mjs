import fs from 'node:fs';
import { findRate, isPriced } from './catalog.mjs';

export function loadRateCard(rateCardPath) {
  return JSON.parse(fs.readFileSync(rateCardPath, 'utf8'));
}

export function priceUsage(model, usage, rateCard) {
  const rate = findRate(model, rateCard);
  if (!isPriced(rate)) {
    return { usd: null, credits: null };
  }

  const cacheWrite = Math.max(0, usage.cacheWriteTokens || 0);
  const cacheWrite1h = Math.min(cacheWrite, Math.max(0, usage.cacheWrite1hTokens || 0));
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  const input = Math.max(0, usage.inputTokens - usage.cachedInputTokens - cacheWrite);
  const cached = Math.max(0, usage.cachedInputTokens);
  const output = Math.max(0, usage.outputTokens);
  const isLongContext =
    rate.longContextThresholdTokens && usage.inputTokens > rate.longContextThresholdTokens;
  const inputMultiplier = isLongContext ? rate.longContextInputMultiplier || 1 : 1;
  const outputMultiplier = isLongContext ? rate.longContextOutputMultiplier || 1 : 1;
  const cacheWritePerMillion = rate.cacheWritePerMillion ?? rate.inputPerMillion;
  const cacheWrite1hPerMillion = rate.cacheWrite1hPerMillion ?? cacheWritePerMillion;
  const usd =
    (inputMultiplier *
        (input * rate.inputPerMillion +
          cached * rate.cachedInputPerMillion +
          cacheWrite5m * cacheWritePerMillion +
          cacheWrite1h * cacheWrite1hPerMillion) +
      outputMultiplier * output * rate.outputPerMillion) /
    1_000_000;

  // Credits are a Codex plan concept; models without credit rates report none.
  if (!Number.isFinite(rate.creditsInputPerMillion)) return { usd, credits: null };
  const creditsCacheWritePerMillion =
    rate.creditsCacheWritePerMillion ?? rate.creditsInputPerMillion;
  return {
    usd,
    credits:
      (inputMultiplier *
          (input * rate.creditsInputPerMillion +
            cached * rate.creditsCachedInputPerMillion +
            cacheWrite * creditsCacheWritePerMillion) +
        outputMultiplier * output * rate.creditsOutputPerMillion) /
      1_000_000,
  };
}
