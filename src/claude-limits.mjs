import fsp from 'node:fs/promises';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const ACTIVE_INTERVAL_MS = 60_000;
const IDLE_INTERVAL_MS = 300_000;
const MIN_POKE_INTERVAL_MS = 30_000;
const TICK_MS = 15_000;
const WINDOW_LABELS = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d Opus', seven_day_sonnet: '7d Sonnet' };
const WINDOW_MINUTES = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080 };

export const NEEDS_CLI_MESSAGE =
  'Claude CLI login has expired. Run `claude` once in a terminal; usage percentages recover automatically.';

// Polls the (unofficial) Claude plan usage endpoint with the Claude Code CLI's OAuth token.
// The token is only read and sent to api.anthropic.com; it is never refreshed, logged, or stored.
export class ClaudeLimitPoller {
  constructor({ credentialsPath, fetchImpl = fetch, now = Date.now, onChange, logger = console }) {
    this.credentialsPath = credentialsPath;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.onChange = onChange;
    this.logger = logger;
    this.timer = null;
    this.polling = false;
    this.lastPollAt = 0;
    this.lastActivityAt = 0;
    this.credentialsMtimeMs = null;
    this.state = { status: 'unknown', message: null, checkedAt: null, limits: [] };
  }

  start() {
    this.poll().catch((error) => this.logger.error(error));
    this.timer = setInterval(() => this.#tick().catch((error) => this.logger.error(error)), TICK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Called when new Claude usage is ingested so percentages follow activity closely.
  poke() {
    this.lastActivityAt = this.now();
    if (this.now() - this.lastPollAt >= MIN_POKE_INTERVAL_MS) {
      this.poll().catch((error) => this.logger.error(error));
    }
  }

  snapshot() {
    return { ...this.state, limits: this.state.limits.map((limit) => ({ ...limit })) };
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    this.lastPollAt = this.now();
    try {
      const next = await this.#fetchLimits();
      const changed = JSON.stringify({ ...next, checkedAt: null }) !== JSON.stringify({ ...this.state, checkedAt: null });
      this.state = { ...next, checkedAt: new Date(this.now()).toISOString() };
      if (changed) this.onChange?.();
    } finally {
      this.polling = false;
    }
  }

  async #tick() {
    // A refreshed credentials file (user ran the CLI) triggers an immediate retry.
    const mtimeMs = await fsp.stat(this.credentialsPath).then((stats) => stats.mtimeMs, () => null);
    const credentialsChanged = mtimeMs !== this.credentialsMtimeMs;
    this.credentialsMtimeMs = mtimeMs;
    if (credentialsChanged && this.state.status !== 'unknown' && this.state.status !== 'ok') return this.poll();
    const active = this.now() - this.lastActivityAt < 10 * 60_000;
    if (this.now() - this.lastPollAt >= (active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS)) return this.poll();
  }

  async #fetchLimits() {
    let oauth;
    try {
      oauth = JSON.parse(await fsp.readFile(this.credentialsPath, 'utf8'))?.claudeAiOauth;
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.error(`Could not read Claude credentials: ${error.message}`);
      return needsCli(this.state.limits);
    }
    if (!oauth?.accessToken) return needsCli(this.state.limits);
    // Skip the request when the stored token is already known to be expired.
    if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= this.now()) return needsCli(this.state.limits);

    let response;
    try {
      response = await this.fetchImpl(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'agent-usage-monitor',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      this.logger.error(`Claude usage request failed: ${error.message}`);
      return failure('Claude usage request failed (network).', this.state.limits);
    }
    if (response.status === 401 || response.status === 403) return needsCli(this.state.limits);
    if (!response.ok) {
      this.logger.error(`Claude usage request returned HTTP ${response.status}.`);
      return failure(`Claude usage request returned HTTP ${response.status}.`, this.state.limits);
    }
    try {
      return { status: 'ok', message: null, limits: parseUsage(await response.json(), this.now()) };
    } catch (error) {
      this.logger.error(`Claude usage response could not be parsed: ${error.message}`);
      return failure('Claude usage response format changed.', this.state.limits);
    }
  }
}

export function parseUsage(body, now = Date.now()) {
  if (!body || typeof body !== 'object') throw new Error('Expected a JSON object.');
  const limits = [];
  for (const [key, value] of Object.entries(body)) {
    const utilization = Number(value?.utilization);
    if (!value || typeof value !== 'object' || !Number.isFinite(utilization)) continue;
    const resetsAt = typeof value.resets_at === 'string' && !Number.isNaN(Date.parse(value.resets_at))
      ? new Date(value.resets_at).toISOString()
      : null;
    limits.push({
      window: WINDOW_LABELS[key] || key,
      usedPercent: resetsAt && Date.parse(resetsAt) <= now ? 0 : utilization,
      windowMinutes: WINDOW_MINUTES[key] || null,
      resetsAt,
    });
  }
  if (!limits.length) throw new Error('No usage windows found.');
  return limits;
}

// Last known values are kept but marked stale so the taskbar can show why they stopped updating.
function needsCli(previous) {
  return { status: 'needs-cli', message: NEEDS_CLI_MESSAGE, limits: previous.map((limit) => ({ ...limit, stale: true })) };
}

function failure(message, previous) {
  return { status: 'error', message, limits: previous.map((limit) => ({ ...limit, stale: true })) };
}
