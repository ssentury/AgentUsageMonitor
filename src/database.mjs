import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { priceUsage } from './pricing.mjs';

const PARSER_VERSION = 4;
const PROVIDERS = new Set(['codex', 'claude']);

export class UsageDatabase {
  constructor(databasePath, rateCard) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.rateCard = rateCard;
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.#createSchema();
    this.#migrateSchema();
    this.#prepareParserVersion();
    this.#refreshPrices();
  }

  close() {
    this.database.close();
  }

  detectedModels() {
    return this.database.prepare('SELECT model, COUNT(*) AS calls FROM calls WHERE excluded = 0 AND model IS NOT NULL GROUP BY model').all();
  }

  updateRateCard(rateCard) {
    const previous = this.rateCard;
    this.rateCard = rateCard;
    try { this.transaction(() => this.#refreshPrices()); }
    catch (error) { this.rateCard = previous; throw error; }
  }

  transaction(callback) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getFileState(filePath) {
    return this.database
      .prepare(
        `SELECT path, offset, size, mtime_ms, session_id, current_turn_id, current_model, current_effort
         FROM files WHERE path = ?`,
      )
      .get(filePath);
  }

  saveFileState(filePath, values) {
    this.database
      .prepare(
        `INSERT INTO files(path, offset, size, mtime_ms, session_id, current_turn_id, current_model, current_effort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           offset = excluded.offset,
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           session_id = excluded.session_id,
           current_turn_id = excluded.current_turn_id,
           current_model = excluded.current_model,
           current_effort = excluded.current_effort`,
      )
      .run(
        filePath,
        values.offset,
        values.size,
        values.mtimeMs,
        values.sessionId,
        values.currentTurnId,
        values.currentModel,
        values.currentEffort,
      );
  }

  applySession(metadata) {
    const parent = metadata.parentSessionId
      ? this.database
          .prepare('SELECT root_session_id FROM sessions WHERE id = ?')
          .get(metadata.parentSessionId)
      : null;
    const rootSessionId = parent?.root_session_id || metadata.parentSessionId || metadata.id;
    const parentTurnId = metadata.parentSessionId
      ? this.#findParentTurn(metadata.parentSessionId, metadata.startedAt) || null
      : null;

    this.database
      .prepare(
        `INSERT INTO sessions(
           id, root_session_id, parent_session_id, parent_turn_id, started_at, updated_at,
           cwd, originator, thread_source, agent_nickname, agent_role, depth, source_file, status, provider
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?)
         ON CONFLICT(id) DO UPDATE SET
           root_session_id = COALESCE(sessions.root_session_id, excluded.root_session_id),
           parent_session_id = COALESCE(sessions.parent_session_id, excluded.parent_session_id),
           parent_turn_id = COALESCE(sessions.parent_turn_id, excluded.parent_turn_id),
           updated_at = MAX(sessions.updated_at, excluded.updated_at),
           cwd = COALESCE(excluded.cwd, sessions.cwd),
           originator = COALESCE(excluded.originator, sessions.originator),
           thread_source = COALESCE(excluded.thread_source, sessions.thread_source),
           agent_nickname = COALESCE(excluded.agent_nickname, sessions.agent_nickname),
           agent_role = COALESCE(excluded.agent_role, sessions.agent_role),
           depth = MAX(sessions.depth, excluded.depth),
           source_file = excluded.source_file`,
      )
      .run(
        metadata.id,
        rootSessionId,
        metadata.parentSessionId,
        parentTurnId,
        metadata.startedAt,
        metadata.startedAt,
        metadata.cwd,
        metadata.originator,
        metadata.threadSource,
        metadata.agentNickname,
        metadata.agentRole,
        metadata.depth,
        metadata.sourceFile,
        metadata.provider || 'codex',
      );
    return { ...metadata, rootSessionId, parentTurnId };
  }

  applyAction(action, eventId) {
    if (action.type === 'turn-start') {
      const session = this.database
        .prepare('SELECT parent_session_id, parent_turn_id, started_at FROM sessions WHERE id = ?')
        .get(action.sessionId);
      let rootTurnId = action.turnId;
      let parentTurnId = session?.parent_turn_id || null;
      if (session?.parent_session_id) {
        parentTurnId ||= this.#findParentTurn(session.parent_session_id, action.at);
        if (parentTurnId) {
          const parentTurn = this.database
            .prepare('SELECT root_turn_id FROM turns WHERE id = ?')
            .get(parentTurnId);
          rootTurnId = parentTurn?.root_turn_id || parentTurnId;
          this.database
            .prepare('UPDATE sessions SET parent_turn_id = COALESCE(parent_turn_id, ?) WHERE id = ?')
            .run(parentTurnId, action.sessionId);
        }
      }
      this.database
        .prepare(
          `INSERT INTO turns(id, session_id, root_turn_id, started_at, status)
           VALUES (?, ?, ?, ?, 'running')
           ON CONFLICT(id) DO UPDATE SET status = 'running', started_at = MIN(turns.started_at, excluded.started_at)`,
        )
        .run(action.turnId, action.sessionId, rootTurnId, action.at);
      this.database
        .prepare("UPDATE sessions SET status = 'running', updated_at = MAX(updated_at, ?) WHERE id = ?")
        .run(action.at, action.sessionId);
      return;
    }

    if (action.type === 'turn-context') {
      this.database
        .prepare(
          `INSERT INTO turns(id, session_id, root_turn_id, started_at, status, model, effort)
           VALUES (?, ?, ?, ?, 'running', ?, ?)
           ON CONFLICT(id) DO UPDATE SET model = excluded.model, effort = excluded.effort`,
        )
        .run(action.turnId, action.sessionId, action.turnId, action.at, action.model, action.effort);
      return;
    }

    if (action.type === 'turn-title') {
      this.database
        .prepare('UPDATE turns SET title = COALESCE(?, title), client_id = COALESCE(?, client_id) WHERE id = ?')
        .run(action.title, action.clientId, action.turnId);
      return;
    }

    if (action.type === 'turn-end') {
      this.database
        .prepare('UPDATE turns SET completed_at = ?, status = ? WHERE id = ?')
        .run(action.at, action.status, action.turnId);
      this.database
        .prepare("UPDATE sessions SET status = 'idle', updated_at = MAX(updated_at, ?) WHERE id = ?")
        .run(action.at, action.sessionId);
      return;
    }

    if (action.type === 'rate-limit') {
      // Rescans replay old files, so only newer observations may replace a window.
      this.database
        .prepare(
          `INSERT INTO rate_limits(provider, window_key, used_percent, window_minutes, resets_at, observed_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, window_key) DO UPDATE SET
             used_percent = excluded.used_percent,
             window_minutes = excluded.window_minutes,
             resets_at = excluded.resets_at,
             observed_at = excluded.observed_at
           WHERE excluded.observed_at >= rate_limits.observed_at`,
        )
        .run(action.provider, action.window, action.usedPercent, action.windowMinutes, action.resetsAt, action.at);
      return;
    }

    if (action.type === 'call') {
      const price = action.excluded
        ? { usd: null, credits: null }
        : priceUsage(action.model, action, this.rateCard);
      // Claude repeats one message across streamed lines (and resumed transcripts);
      // keep the first attribution but the most complete token counts.
      const existing = this.database
        .prepare('SELECT output_tokens, total_tokens FROM calls WHERE event_id = ?')
        .get(eventId);
      if (existing) {
        if (action.outputTokens <= existing.output_tokens && action.totalTokens <= existing.total_tokens) return;
        this.database
          .prepare(
            `UPDATE calls SET input_tokens = ?, cached_input_tokens = ?, cache_write_tokens = ?,
               cache_write_1h_tokens = ?, output_tokens = ?, reasoning_tokens = ?, total_tokens = ?,
               usd = ?, credits = ?
             WHERE event_id = ?`,
          )
          .run(
            action.inputTokens,
            action.cachedInputTokens,
            action.cacheWriteTokens,
            action.cacheWrite1hTokens || 0,
            action.outputTokens,
            action.reasoningTokens,
            action.totalTokens,
            price.usd,
            price.credits,
            eventId,
          );
        return;
      }
      const turn = this.database
        .prepare('SELECT root_turn_id FROM turns WHERE id = ?')
        .get(action.turnId);
      const rootTurnId = turn?.root_turn_id || action.turnId;
      this.database
        .prepare(
          `INSERT INTO calls(
             event_id, provider, session_id, turn_id, root_turn_id, event_at, model, effort,
             input_tokens, cached_input_tokens, cache_write_tokens, cache_write_1h_tokens, output_tokens,
             reasoning_tokens, total_tokens, excluded, usd, credits
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          action.provider || 'codex',
          action.sessionId,
          action.turnId,
          rootTurnId,
          action.at,
          action.model,
          action.effort,
          action.inputTokens,
          action.cachedInputTokens,
          action.cacheWriteTokens,
          action.cacheWrite1hTokens || 0,
          action.outputTokens,
          action.reasoningTokens,
          action.totalTokens,
          action.excluded ? 1 : 0,
          price.usd,
          price.credits,
        );
    }
  }

  rateLimits(provider) {
    return this.database
      .prepare(
        `SELECT window_key, used_percent, window_minutes, resets_at, observed_at
         FROM rate_limits WHERE provider = ? ORDER BY window_minutes`,
      )
      .all(provider)
      .map(normalizeNumbers);
  }

  reconcileAttributions() {
    const sessions = this.database
      .prepare(
        `SELECT id, parent_session_id, parent_turn_id, root_session_id, started_at
         FROM sessions
         WHERE parent_session_id IS NOT NULL
         ORDER BY depth, started_at`,
      )
      .all();
    const findParentTurn = this.database.prepare(
      `SELECT id FROM turns
       WHERE session_id = ? AND started_at <= ?
       ORDER BY CASE WHEN completed_at IS NULL OR completed_at >= ? THEN 0 ELSE 1 END,
                started_at DESC
       LIMIT 1`,
    );
    const findParent = this.database.prepare(
      `SELECT s.root_session_id, t.root_turn_id
       FROM sessions s
       JOIN turns t ON t.id = ?
       WHERE s.id = ?`,
    );
    const updateSession = this.database.prepare(
      'UPDATE sessions SET root_session_id = ?, parent_turn_id = ? WHERE id = ?',
    );
    const updateTurns = this.database.prepare(
      'UPDATE turns SET root_turn_id = ? WHERE session_id = ? AND root_turn_id <> ?',
    );
    const updateCalls = this.database.prepare(
      'UPDATE calls SET root_turn_id = ? WHERE session_id = ? AND root_turn_id <> ?',
    );

    for (const session of sessions) {
      const parentTurnId = findParentTurn.get(
        session.parent_session_id,
        session.started_at,
        session.started_at,
      )?.id;
      if (!parentTurnId) continue;
      const parent = findParent.get(parentTurnId, session.parent_session_id);
      if (!parent) continue;
      const rootTurnId = parent.root_turn_id || parentTurnId;
      const rootSessionId = parent.root_session_id || session.parent_session_id;
      if (session.root_session_id !== rootSessionId || session.parent_turn_id !== parentTurnId) {
        updateSession.run(rootSessionId, parentTurnId, session.id);
      }
      updateTurns.run(rootTurnId, session.id, rootTurnId);
      updateCalls.run(rootTurnId, session.id, rootTurnId);
    }
  }

  listRootTurns({ limit = 100, days = 30, provider = null } = {}) {
    const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const since = periodStartIso(days);
    const providerFilter = normalizeProvider(provider);
    const turns = this.database
      .prepare(
        `SELECT t.id, t.session_id, t.started_at, t.completed_at, t.status, t.model, t.effort,
                t.title, s.cwd, s.provider
         FROM turns t
         JOIN sessions s ON s.id = t.session_id
         WHERE t.root_turn_id = t.id
           AND COALESCE(s.thread_source, 'user') = 'user'
           AND t.started_at >= ?
           AND (? IS NULL OR s.provider = ?)
         ORDER BY t.started_at DESC
         LIMIT ?`,
      )
      .all(since, providerFilter, providerFilter, boundedLimit);
    if (turns.length === 0) return [];

    const turnIds = turns.map((turn) => turn.id);
    const placeholders = turnIds.map(() => '?').join(',');
    const modelRows = this.database
      .prepare(
        `SELECT root_turn_id, model, effort,
                COUNT(*) AS calls,
                SUM(input_tokens) AS input_tokens,
                SUM(cached_input_tokens) AS cached_input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(reasoning_tokens) AS reasoning_tokens,
                SUM(total_tokens) AS total_tokens,
                SUM(usd) AS usd,
                SUM(credits) AS credits,
                SUM(CASE WHEN usd IS NULL THEN 1 ELSE 0 END) AS unpriced_calls
         FROM calls
         WHERE excluded = 0 AND root_turn_id IN (${placeholders})
         GROUP BY root_turn_id, model, effort
         ORDER BY root_turn_id, SUM(total_tokens) DESC`,
      )
      .all(...turnIds);
    const childRows = this.database
      .prepare(
        `SELECT s.id, s.parent_turn_id, s.agent_nickname, s.agent_role, s.depth, s.status,
                (SELECT latest.model FROM turns latest
                 WHERE latest.session_id = s.id
                 ORDER BY latest.started_at DESC LIMIT 1) AS model,
                (SELECT latest.effort FROM turns latest
                 WHERE latest.session_id = s.id
                 ORDER BY latest.started_at DESC LIMIT 1) AS effort,
                MIN(t.started_at) AS started_at,
                CASE WHEN s.status = 'running' THEN NULL ELSE MAX(t.completed_at) END AS completed_at,
                SUM(CASE WHEN c.excluded = 0 THEN 1 ELSE 0 END) AS calls,
                COALESCE(SUM(CASE WHEN c.excluded = 0 THEN c.input_tokens ELSE 0 END), 0) AS input_tokens,
                COALESCE(SUM(CASE WHEN c.excluded = 0 THEN c.cached_input_tokens ELSE 0 END), 0) AS cached_input_tokens,
                COALESCE(SUM(CASE WHEN c.excluded = 0 THEN c.output_tokens ELSE 0 END), 0) AS output_tokens,
                COALESCE(SUM(CASE WHEN c.excluded = 0 THEN c.total_tokens ELSE 0 END), 0) AS total_tokens,
                SUM(CASE WHEN c.excluded = 0 THEN c.usd ELSE 0 END) AS usd,
                SUM(CASE WHEN c.excluded = 0 THEN c.credits ELSE 0 END) AS credits
         FROM sessions s
         LEFT JOIN turns t ON t.session_id = s.id
         LEFT JOIN calls c ON c.turn_id = t.id
         WHERE s.parent_turn_id IN (${placeholders})
         GROUP BY s.id
         HAVING SUM(CASE WHEN c.excluded = 0 THEN 1 ELSE 0 END) > 0
         ORDER BY MIN(t.started_at)`,
      )
      .all(...turnIds);

    return turns.map((turn) => {
      const models = modelRows.filter((row) => row.root_turn_id === turn.id).map(normalizeNumbers);
      const children = childRows.filter((row) => row.parent_turn_id === turn.id).map(normalizeNumbers);
      const totals = models.reduce(
        (sum, model) => ({
          calls: sum.calls + model.calls,
          inputTokens: sum.inputTokens + model.inputTokens,
          cachedInputTokens: sum.cachedInputTokens + model.cachedInputTokens,
          outputTokens: sum.outputTokens + model.outputTokens,
          reasoningTokens: sum.reasoningTokens + model.reasoningTokens,
          totalTokens: sum.totalTokens + model.totalTokens,
          usd: sum.usd + (model.usd || 0),
          credits: sum.credits + (model.credits || 0),
          hasUnpriced: sum.hasUnpriced || model.unpricedCalls > 0,
        }),
        {
          calls: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          usd: 0,
          credits: 0,
          hasUnpriced: false,
        },
      );
      return { ...turn, models, children, totals };
    });
  }

  summary(days = 30, provider = null) {
    const since = periodStartIso(days);
    const providerFilter = normalizeProvider(provider);
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(SUM(usd), 0) AS usd,
                COALESCE(SUM(credits), 0) AS credits,
                SUM(CASE WHEN usd IS NULL THEN 1 ELSE 0 END) AS unpriced_calls,
                MAX(event_at) AS latest_event_at
         FROM calls WHERE excluded = 0 AND event_at >= ? AND (? IS NULL OR provider = ?)`,
      )
      .get(since, providerFilter, providerFilter);
    return normalizeNumbers(row);
  }

  // API-equivalent USD per provider since an ISO timestamp.
  providerCost(since) {
    const rows = this.database
      .prepare(
        `SELECT provider, COALESCE(SUM(usd), 0) AS usd,
                SUM(CASE WHEN usd IS NULL THEN 1 ELSE 0 END) AS unpriced_calls,
                MAX(event_at) AS latest_event_at
         FROM calls WHERE excluded = 0 AND event_at >= ? GROUP BY provider`,
      )
      .all(since);
    return new Map(rows.map((row) => [row.provider, normalizeNumbers(row)]));
  }

  // Spend per fixed-size time bucket, only buckets that saw any priced usage.
  costBuckets(provider, since, bucketSeconds) {
    return this.database
      .prepare(
        `SELECT SUM(usd) AS usd FROM calls
         WHERE excluded = 0 AND provider = ? AND event_at >= ? AND usd IS NOT NULL
         GROUP BY CAST(strftime('%s', event_at) AS INTEGER) / ?`,
      )
      .all(provider, since, bucketSeconds)
      .map((row) => row.usd);
  }

  counts() {
    return this.database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions) AS sessions,
           (SELECT COUNT(*) FROM turns) AS turns,
           (SELECT COUNT(*) FROM calls WHERE excluded = 0) AS calls,
           (SELECT MAX(event_at) FROM calls WHERE excluded = 0) AS latest_event_at`,
      )
      .get();
  }

  #findParentTurn(parentSessionId, at) {
    return this.database
      .prepare(
        `SELECT id FROM turns
         WHERE session_id = ? AND started_at <= ?
         ORDER BY CASE WHEN completed_at IS NULL OR completed_at >= ? THEN 0 ELSE 1 END,
                  started_at DESC
         LIMIT 1`,
      )
      .get(parentSessionId, at, at)?.id;
  }

  #createSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        offset INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0,
        session_id TEXT,
        current_turn_id TEXT,
        current_model TEXT,
        current_effort TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        root_session_id TEXT,
        parent_session_id TEXT,
        parent_turn_id TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cwd TEXT,
        originator TEXT,
        thread_source TEXT,
        agent_nickname TEXT,
        agent_role TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        source_file TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        provider TEXT NOT NULL DEFAULT 'codex'
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        root_turn_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        title TEXT,
        client_id TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE TABLE IF NOT EXISTS calls (
        event_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'codex',
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        root_turn_id TEXT NOT NULL,
        event_at TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        excluded INTEGER NOT NULL DEFAULT 0,
        usd REAL,
        credits REAL,
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(turn_id) REFERENCES turns(id)
      );
      CREATE INDEX IF NOT EXISTS idx_turns_root_started ON turns(root_turn_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_session_started ON turns(session_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_calls_root_event ON calls(root_turn_id, event_at);
      CREATE INDEX IF NOT EXISTS idx_calls_turn ON calls(turn_id);
      CREATE INDEX IF NOT EXISTS idx_calls_session_root ON calls(session_id, root_turn_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_parent_turn ON sessions(parent_turn_id);
      CREATE TABLE IF NOT EXISTS rate_limits (
        provider TEXT NOT NULL,
        window_key TEXT NOT NULL,
        used_percent REAL NOT NULL,
        window_minutes INTEGER NOT NULL,
        resets_at TEXT,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(provider, window_key)
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // Adds provider-era columns to databases created by the Codex-only version.
  #migrateSchema() {
    const ensureColumn = (table, column, definition) => {
      const columns = this.database.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((row) => row.name === column)) {
        this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };
    ensureColumn('sessions', 'provider', "TEXT NOT NULL DEFAULT 'codex'");
    ensureColumn('calls', 'provider', "TEXT NOT NULL DEFAULT 'codex'");
    ensureColumn('calls', 'cache_write_1h_tokens', 'INTEGER NOT NULL DEFAULT 0');
    this.database.exec(`
      DROP INDEX IF EXISTS idx_calls_widget_event;
      CREATE INDEX IF NOT EXISTS idx_calls_provider_event ON calls(provider, event_at) WHERE excluded = 0;
    `);
  }

  #prepareParserVersion() {
    const stored = Number(
      this.database.prepare("SELECT value FROM metadata WHERE key = 'parser_version'").get()?.value || 0,
    );
    if (stored >= PARSER_VERSION) return;
    this.database.exec('UPDATE files SET offset = 0, size = 0, mtime_ms = 0;');
    this.database
      .prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('parser_version', ?)")
      .run(String(PARSER_VERSION));
  }

  #refreshPrices() {
    const fingerprint = JSON.stringify(this.rateCard);
    const stored = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'rate_card'")
      .get()?.value;
    if (stored === fingerprint) return;

    const calls = this.database
      .prepare(
        `SELECT event_id, model, input_tokens, cached_input_tokens, cache_write_tokens,
                cache_write_1h_tokens, output_tokens
         FROM calls WHERE excluded = 0`,
      )
      .all();
    const update = this.database.prepare('UPDATE calls SET usd = ?, credits = ? WHERE event_id = ?');
    for (const call of calls) {
      const price = priceUsage(
        call.model,
        {
          inputTokens: call.input_tokens,
          cachedInputTokens: call.cached_input_tokens,
          cacheWriteTokens: call.cache_write_tokens,
          cacheWrite1hTokens: call.cache_write_1h_tokens,
          outputTokens: call.output_tokens,
        },
        this.rateCard,
      );
      update.run(price.usd, price.credits, call.event_id);
    }
    this.database
      .prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('rate_card', ?)")
      .run(fingerprint);
  }
}

function normalizeProvider(value) {
  return PROVIDERS.has(value) ? value : null;
}

export function periodStartIso(period) {
  if (period === 'today') {
    const localMidnight = new Date();
    localMidnight.setHours(0, 0, 0, 0);
    return localMidnight.toISOString();
  }
  const boundedDays = Math.min(Math.max(Number(period) || 30, 1), 3650);
  return new Date(Date.now() - boundedDays * 86_400_000).toISOString();
}

function normalizeNumbers(row) {
  if (!row) return row;
  const output = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    output[camelKey] = typeof value === 'bigint' ? Number(value) : value;
  }
  return output;
}
