import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { UsageDatabase } from '../src/database.mjs';
import { priceUsage } from '../src/pricing.mjs';
import { SessionScanner } from '../src/scanner.mjs';
import { codexParser } from '../src/parsers/codex.mjs';

const rateCard = {
  models: {
    'gpt-5.6-sol': {
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 30,
      creditsInputPerMillion: 125,
      creditsCachedInputPerMillion: 12.5,
      creditsOutputPerMillion: 750,
    },
    'gpt-5.6-luna': {
      inputPerMillion: 0.2,
      cachedInputPerMillion: 0.02,
      outputPerMillion: 1.2,
      creditsInputPerMillion: 5,
      creditsCachedInputPerMillion: 0.5,
      creditsOutputPerMillion: 30,
    },
  },
};

test('scanner attributes child calls to the root turn and excludes auto review', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-monitor-'));
  const sessionsRoot = path.join(root, 'sessions');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const database = new UsageDatabase(path.join(root, 'state', 'usage.sqlite3'), rateCard);
  context.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  writeJsonl(path.join(sessionsRoot, '01-main.jsonl'), [
    record('2026-08-04T00:00:00.000Z', 'session_meta', {
      id: 'main', session_id: 'main', cwd: 'D:/work/game', originator: 'Codex Desktop', source: 'vscode', thread_source: 'user',
    }),
    event('2026-08-04T00:00:01.000Z', 'task_started', { turn_id: 'root-turn' }),
    record('2026-08-04T00:00:01.100Z', 'turn_context', { turn_id: 'root-turn', model: 'gpt-5.6-sol', effort: 'high' }),
    event('2026-08-04T00:00:01.200Z', 'user_message', { message: 'Investigate the orchestration result.' }),
    token('2026-08-04T00:00:02.000Z', 1000, 600, 100),
    event('2026-08-04T00:00:10.000Z', 'task_complete', { turn_id: 'root-turn' }),
  ]);
  writeJsonl(path.join(sessionsRoot, '02-child.jsonl'), [
    record('2026-08-04T00:00:03.000Z', 'session_meta', {
      id: 'child', session_id: 'main', cwd: 'D:/work/game', originator: 'Codex Desktop',
      source: { subagent: { thread_spawn: { parent_thread_id: 'main', depth: 1, agent_nickname: 'Luna' } } },
      thread_source: 'subagent',
    }),
    event('2026-08-04T00:00:03.100Z', 'task_started', { turn_id: 'child-turn' }),
    record('2026-08-04T00:00:03.200Z', 'turn_context', { turn_id: 'child-turn', model: 'gpt-5.6-luna', effort: 'xhigh' }),
    token('2026-08-04T00:00:04.000Z', 500, 300, 50),
    event('2026-08-04T00:00:05.000Z', 'task_complete', { turn_id: 'child-turn' }),
  ]);
  writeJsonl(path.join(sessionsRoot, '03-review.jsonl'), [
    record('2026-08-04T00:00:06.000Z', 'session_meta', {
      id: 'review', session_id: 'main', source: { subagent: { other: 'guardian' } }, thread_source: 'subagent',
    }),
    event('2026-08-04T00:00:06.100Z', 'task_started', { turn_id: 'review-turn' }),
    record('2026-08-04T00:00:06.200Z', 'turn_context', { turn_id: 'review-turn', model: 'codex-auto-review', effort: 'low' }),
    token('2026-08-04T00:00:07.000Z', 9000, 0, 500),
    event('2026-08-04T00:00:08.000Z', 'task_complete', { turn_id: 'review-turn' }),
  ]);

  const scanner = new SessionScanner({ parser: codexParser, root: sessionsRoot, lookbackDays: 3650, database });
  await scanner.fullScan();
  const turns = database.listRootTurns({ days: 3650 });

  assert.equal(turns.length, 1);
  assert.equal(turns[0].title, 'Investigate the orchestration result.');
  assert.equal(turns[0].totals.calls, 2);
  assert.equal(turns[0].totals.inputTokens, 1500);
  assert.deepEqual(turns[0].models.map((model) => model.model).sort(), ['gpt-5.6-luna', 'gpt-5.6-sol']);
  assert.equal(turns[0].children.length, 1);
  assert.equal(turns[0].children[0].agentNickname, 'Luna');
  assert.equal(turns[0].children[0].model, 'gpt-5.6-luna');
});

test('scanner reads modern user messages and repairs out-of-order child attribution', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-monitor-'));
  const sessionsRoot = path.join(root, 'sessions');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const database = new UsageDatabase(path.join(root, 'state', 'usage.sqlite3'), rateCard);
  context.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // A restarted monitor can encounter a newly spawned child file before the still-running parent file.
  writeJsonl(path.join(sessionsRoot, '01-child.jsonl'), [
    record('2026-08-04T10:01:00.000Z', 'session_meta', {
      id: 'child-late-scan',
      session_id: 'main-late-scan',
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: 'main-late-scan',
            depth: 1,
            agent_nickname: 'Halley',
          },
        },
      },
      thread_source: 'subagent',
    }),
    event('2026-08-04T10:01:01.000Z', 'task_started', { turn_id: 'child-current' }),
    record('2026-08-04T10:01:02.000Z', 'turn_context', {
      turn_id: 'child-current', model: 'gpt-5.6-luna', effort: 'xhigh',
    }),
    token('2026-08-04T10:01:03.000Z', 500, 300, 50),
    event('2026-08-04T10:01:04.000Z', 'task_complete', { turn_id: 'child-current' }),
    event('2026-08-04T10:02:00.000Z', 'task_started', { turn_id: 'child-follow-up' }),
    record('2026-08-04T10:02:01.000Z', 'turn_context', {
      turn_id: 'child-follow-up', model: 'gpt-5.6-luna', effort: 'xhigh',
    }),
    token('2026-08-04T10:02:02.000Z', 600, 400, 60),
  ]);
  writeJsonl(path.join(sessionsRoot, '02-parent.jsonl'), [
    record('2026-08-04T09:00:00.000Z', 'session_meta', {
      id: 'main-late-scan', session_id: 'main-late-scan', thread_source: 'user',
    }),
    event('2026-08-04T09:00:01.000Z', 'task_started', { turn_id: 'old-turn' }),
    record('2026-08-04T09:00:02.000Z', 'turn_context', {
      turn_id: 'old-turn', model: 'gpt-5.6-sol', effort: 'high',
    }),
    event('2026-08-04T09:10:00.000Z', 'task_complete', { turn_id: 'old-turn' }),
    event('2026-08-04T10:00:00.000Z', 'task_started', { turn_id: 'current-turn' }),
    record('2026-08-04T10:00:01.000Z', 'turn_context', {
      turn_id: 'current-turn', model: 'gpt-5.6-sol', effort: 'xhigh',
    }),
    record('2026-08-04T10:00:02.000Z', 'response_item', {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: '# Files mentioned by the user:\n\n## screenshot.png\n\n## My request:\nFix the current orchestration issue.',
      }],
      internal_chat_message_metadata_passthrough: {
        turn_id: 'current-turn',
        content_item_kinds: ['user.text'],
      },
    }),
    token('2026-08-04T10:00:03.000Z', 1000, 600, 100),
  ]);

  const scanner = new SessionScanner({ parser: codexParser, root: sessionsRoot, lookbackDays: 3650, database });
  await scanner.fullScan();

  const turns = database.listRootTurns({ limit: 10, days: 3650 });
  const current = turns.find((turn) => turn.id === 'current-turn');
  const old = turns.find((turn) => turn.id === 'old-turn');
  assert.equal(current.title, 'Fix the current orchestration issue.');
  assert.equal(current.children.length, 1);
  assert.equal(current.children[0].agentNickname, 'Halley');
  assert.equal(old.children.length, 0);
});

test('pricing includes cache writes and long-context multipliers', () => {
  const card = {
    models: {
      model: {
        inputPerMillion: 10,
        cachedInputPerMillion: 1,
        cacheWritePerMillion: 12.5,
        outputPerMillion: 50,
        creditsInputPerMillion: 250,
        creditsCachedInputPerMillion: 25,
        creditsCacheWritePerMillion: 312.5,
        creditsOutputPerMillion: 1250,
        longContextThresholdTokens: 272000,
        longContextInputMultiplier: 2,
        longContextOutputMultiplier: 1.5,
      },
    },
  };
  const price = priceUsage(
    'model',
    {
      inputTokens: 300000,
      cachedInputTokens: 100000,
      cacheWriteTokens: 50000,
      outputTokens: 10000,
    },
    card,
  );
  assert.equal(price.usd, 5.2);
  assert.equal(price.credits, 130);
});

function record(timestamp, type, payload) {
  return { timestamp, type, payload };
}

function event(timestamp, type, extra) {
  return record(timestamp, 'event_msg', { type, ...extra });
}

function token(timestamp, input, cached, output) {
  return event(timestamp, 'token_count', {
    info: {
      last_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        cache_write_input_tokens: 0,
        output_tokens: output,
        reasoning_output_tokens: Math.floor(output / 2),
        total_tokens: input + output,
      },
    },
  });
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}
