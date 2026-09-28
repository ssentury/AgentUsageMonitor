import fs from 'node:fs';

export const priceFields = ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion',
  'cacheWritePerMillion', 'cacheWrite1hPerMillion', 'longContextThresholdTokens', 'longContextInputMultiplier', 'longContextOutputMultiplier'];

export function validateModels(models) {
  if (!models || typeof models !== 'object' || Array.isArray(models) || Object.keys(models).length > 2000) {
    throw new Error('Expected a model catalog object (at most 2000 models).');
  }
  const clean = Object.create(null);
  for (const [model, rate] of Object.entries(models)) {
    if (!model.trim() || model.length > 200 || /[\x00-\x1f]/.test(model) || ['__proto__', 'constructor', 'prototype'].includes(model)) {
      throw new Error('Invalid model identifier.');
    }
    if (rate === null) { clean[model] = null; continue; }
    if (typeof rate !== 'object' || Array.isArray(rate)) throw new Error(`Invalid prices for ${model}.`);
    if (Object.keys(rate).some((key) => !priceFields.includes(key))) throw new Error(`${model}: unrecognized price field.`);
    const normalized = {};
    for (const key of priceFields) {
      const value = rate[key];
      if (value == null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9) {
        throw new Error(`${model}: ${key} must be a nonnegative number.`);
      }
      if (key === 'longContextThresholdTokens' && (!Number.isInteger(value) || value < 1)) {
        throw new Error('Long-context threshold must be a positive whole number.');
      }
      if (key.endsWith('Multiplier') && value <= 0) throw new Error('Multipliers must be greater than zero.');
      normalized[key] = value;
    }
    clean[model] = normalized;
  }
  return clean;
}

export function isPriced(rate) {
  return !!rate && ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion']
    .every((key) => typeof rate[key] === 'number' && Number.isFinite(rate[key]) && rate[key] >= 0);
}

// Exact IDs win; dated snapshots such as claude-haiku-4-5-20251001 fall back to their alias.
export function findRate(model, rateCard) {
  const models = rateCard.models || {};
  if (Object.hasOwn(models, model)) return models[model];
  const alias = String(model || '').replace(/-\d{8}$/, '');
  return alias !== model && Object.hasOwn(models, alias) ? models[alias] : undefined;
}

export class PriceCatalog {
  constructor(defaults, filePath) {
    this.defaults = defaults;
    this.filePath = filePath;
    this.overrides = Object.create(null);
    if (fs.existsSync(filePath)) this.overrides = validateModels(JSON.parse(fs.readFileSync(filePath, 'utf8')).models);
  }

  rateCard(overrides = this.overrides) {
    const models = { ...this.defaults.models };
    for (const [model, value] of Object.entries(overrides)) {
      if (value === null) continue;
      const rate = { ...value };
      // Credits only exist for Codex plans; Claude overrides stay USD-only.
      if (/^claude-/i.test(model)) { models[model] = rate; continue; }
      for (const kind of ['Input', 'CachedInput', 'Output', 'CacheWrite']) {
        const key = kind[0].toLowerCase() + kind.slice(1) + 'PerMillion';
        if (rate[key] != null) rate[`credits${kind}PerMillion`] = rate[key] * 25;
      }
      models[model] = rate;
    }
    return { ...this.defaults, models };
  }

  update(patch, apply) {
    const validated = validateModels(patch);
    const next = { ...this.overrides };
    for (const [model, rate] of Object.entries(validated)) {
      if (rate === null) delete next[model]; else next[model] = rate;
    }
    const temporary = this.filePath + '.tmp';
    const previous = fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath) : null;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, models: next }, null, 2) + '\n');
    fs.renameSync(temporary, this.filePath);
    try { apply(this.rateCard(next)); } catch (error) {
      if (previous) fs.writeFileSync(this.filePath, previous); else fs.unlinkSync(this.filePath);
      throw error;
    }
    this.overrides = next;
  }

  snapshot(detected) {
    const card = this.rateCard();
    const rates = card.models;
    const seen = new Map(detected.map((row) => [row.model, row.calls]));
    return { version: 1, creditsPerUsd: 25, models: [...new Set([...Object.keys(rates), ...seen.keys()])]
      .filter(Boolean).map((model) => ({ model, rate: rates[model] || findRate(model, card) || {}, calls: seen.get(model) || 0,
        priced: isPriced(findRate(model, card)), source: Object.hasOwn(this.overrides, model) ? 'custom' : Object.hasOwn(this.defaults.models, model) ? 'bundled' : 'detected',
        hasDefault: Object.hasOwn(this.defaults.models, model) }))
      .sort((a, b) => Number(a.priced) - Number(b.priced) || a.model.localeCompare(b.model)) };
  }
}
