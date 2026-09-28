import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { UsageDatabase } from '../src/database.mjs';
import { priceUsage } from '../src/pricing.mjs';
import { SessionScanner } from '../src/scanner.mjs';
import { claudeParser } from '../src/parsers/claude.mjs';
import { codexParser } from '../src/parsers/codex.mjs';
import { ClaudeLimitPoller, parseUsage } from '../src/claude-limits.mjs';
import { taskbarSnapshot } from '../src/taskbar.mjs';

const rateCard = {
  models: {
    'claude-opus-5-5': {
      inputPerMillion: 4, cachedInputPerMillion: 0.2, cacheWritePerMillion: 5, cacheWrite1hPerMillion: 8, outputPerMillion: 20,
    },
    'claude-haiku-4-5': {
      inputPerMillion: 1, cachedInputPerMillion: 0.1, cacheWritePerMillion: 1.25, cacheWrite1hPerMillion: 2, outputPerMillion: 5,
    },
  },
};

function setup(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-usage-monitor-'));
  const projects = path.join(root, 'projects', 'C--work-game');
  fs.mkdirSync(path.join(projects, 'session-1', 'subagents'), { recursive: true });
  const database = new UsageDatabase(path.join(root, 'state', 'usage.sqlite3'), rateCard);
  context.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, projects, database };
}

test('claude transcripts count streamed duplicates once and attribute subagents to the prompt', async (context) => {
  const { root, projects, database } = setup(context);
  writeJsonl(path.join(projects, 'session-1.jsonl'), [
    { type: 'queue-operation', sessionId: 'session-1', timestamp: '2026-09-28T00:00:00.000Z' },
    user('2026-09-28T00:00:01.000Z', 'Fix the <b>bug</b> <system-reminder>ignore</system-reminder>please', { promptId: 'p1' }),
    assistant('2026-09-28T00:00:02.000Z', 'msg-1', 'req-1', 8, null),
    assistant('2026-09-28T00:00:02.500Z', 'msg-1', 'req-1', 400, 'tool_use'),
    user('2026-09-28T00:00:03.000Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], { promptId: 'p1' }),
    assistant('2026-09-28T00:00:20.000Z', 'msg-3', 'req-3', 100, 'end_turn'),
  ]);
  writeJsonl(path.join(projects, 'session-1', 'subagents', 'agent-abc.jsonl'), [
    user('2026-09-28T00:00:05.000Z', 'Explore the code', { isSidechain: true, agentId: 'abc' }),
    assistant('2026-09-28T00:00:06.000Z', 'msg-2', 'req-2', 50, 'end_turn', { model: 'claude-haiku-4-5-20251001', isSidechain: true, agentId: 'abc' }),
  ]);
  fs.writeFileSync(path.join(projects, 'session-1', 'subagents', 'agent-abc.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Scan code' }));

  const scanner = new SessionScanner({ parser: claudeParser, root: path.join(root, 'projects'), lookbackDays: 3650, database });
  await scanner.fullScan();
  const turns = database.listRootTurns({ days: 3650, provider: 'claude' });

  assert.equal(turns.length, 1);
  assert.equal(turns[0].provider, 'claude');
  assert.equal(turns[0].title, 'Fix the <b>bug</b> please');
  assert.equal(turns[0].status, 'completed');
  assert.equal(turns[0].totals.calls, 3);
  assert.equal(turns[0].totals.outputTokens, 400 + 100 + 50);
  assert.equal(turns[0].children.length, 1);
  assert.equal(turns[0].children[0].agentRole, 'Explore');
  // Dated model IDs are priced through their alias.
  assert.ok(turns[0].children[0].usd > 0);
  assert.equal(database.listRootTurns({ days: 3650, provider: 'codex' }).length, 0);

  // A resumed transcript that copies the same message must not double count.
  writeJsonl(path.join(projects, 'session-2.jsonl'), [
    user('2026-09-28T01:00:00.000Z', 'Continue', { sessionId: 'session-2', promptId: 'p2' }),
    assistant('2026-09-28T00:00:02.500Z', 'msg-1', 'req-1', 400, 'tool_use', { sessionId: 'session-2' }),
  ]);
  await scanner.fullScan();
  assert.equal(database.summary(3650, 'claude').calls, 3);
});

test('claude pricing separates 5-minute and 1-hour cache writes', () => {
  const price = priceUsage('claude-opus-5-5', {
    inputTokens: 1_000_000 + 1_000_000 + 3_000_000,
    cachedInputTokens: 1_000_000,
    cacheWriteTokens: 3_000_000,
    cacheWrite1hTokens: 1_000_000,
    outputTokens: 1_000_000,
  }, rateCard);
  // input 4 + cache read 0.2 + 5m writes 2×5 + 1h write 8 + output 20
  assert.equal(price.usd, 42.2);
  assert.equal(price.credits, null);
});

test('codex rate limits keep the newest observation and feed the taskbar snapshot', async (context) => {
  const { root, database } = setup(context);
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const future = Math.floor(Date.now() / 1000) + 3600;
  const limits = (percent) => ({ limit_id: 'codex', primary: { used_percent: percent, window_minutes: 10080, resets_at: future } });
  writeJsonl(path.join(sessions, 'a.jsonl'), [
    { timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 's', cwd: 'D:/x' } },
    { timestamp: new Date(Date.now() - 1000).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: limits(12) } },
    { timestamp: new Date(Date.now() - 5000).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: limits(5) } },
  ]);
  const scanner = new SessionScanner({ parser: codexParser, root: sessions, lookbackDays: 3650, database });
  await scanner.fullScan();

  const snapshot = taskbarSnapshot(database, { status: 'needs-cli', message: 'run cli', limits: [] });
  const codex = snapshot.providers.find((provider) => provider.id === 'codex');
  assert.deepEqual(codex.limits.map((limit) => [limit.window, limit.usedPercent]), [['7d', 12]]);
  assert.equal(snapshot.providers.find((provider) => provider.id === 'claude').limitStatus, 'needs-cli');
});

test('claude usage poller reports needs-cli for expired tokens without calling the API, then recovers', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-usage-limits-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentialsPath = path.join(root, '.credentials.json');
  const writeToken = (expiresAt) => fs.writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'token', expiresAt } }));
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    assert.equal(options.headers.Authorization, 'Bearer token');
    return new Response(JSON.stringify({
      five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3600_000).toISOString() },
      seven_day: { utilization: 18.5, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
      extra_usage: { is_enabled: false },
    }), { status: 200 });
  };
  const poller = new ClaudeLimitPoller({ credentialsPath, fetchImpl, logger: { error() {} } });

  writeToken(Date.now() - 1000);
  await poller.poll();
  assert.equal(poller.snapshot().status, 'needs-cli');
  assert.equal(calls, 0);

  writeToken(Date.now() + 3600_000);
  await poller.poll();
  assert.equal(poller.snapshot().status, 'ok');
  assert.deepEqual(poller.snapshot().limits.map((limit) => [limit.window, limit.usedPercent]), [['5h', 42], ['7d', 18.5]]);
});

test('claude usage parser rejects unknown formats', () => {
  assert.throws(() => parseUsage({ something: 'else' }));
});

function user(timestamp, content, extra = {}) {
  return { type: 'user', sessionId: 'session-1', cwd: 'C:/work/game', entrypoint: 'claude-desktop', uuid: `u-${timestamp}`, timestamp, message: { role: 'user', content }, ...extra };
}

function assistant(timestamp, id, requestId, output, stopReason, extra = {}) {
  return {
    type: 'assistant', sessionId: 'session-1', cwd: 'C:/work/game', uuid: `a-${timestamp}`, requestId, timestamp,
    message: {
      id, model: extra.model || 'claude-opus-5-5', stop_reason: stopReason,
      usage: {
        input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: output,
        cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 },
      },
    },
    ...extra,
  };
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}
