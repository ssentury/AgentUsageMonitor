import fs from 'node:fs';
import path from 'node:path';

import { compactTitle, integerValue, normalizeTimestamp, stringValue } from './common.mjs';

const TURN_END_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

// Parses Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl).
// Subagents are written to <project>/<session>/subagents/agent-<id>.jsonl.
export const claudeParser = {
  provider: 'claude',
  createState(saved = {}) {
    return {
      sessionId: saved.sessionId || null,
      currentTurnId: saved.currentTurnId || null,
      currentModel: saved.currentModel || null,
      currentEffort: saved.currentEffort || null,
    };
  },
  parse(record, state, sourceFile) {
    if (!record || (record.type !== 'user' && record.type !== 'assistant')) return [];
    const actions = [];
    const at = normalizeTimestamp(record.timestamp);

    // Sessions are created lazily on the first conversational record, which carries cwd.
    if (!state.sessionId) {
      const metadata = sessionMetadata(record, sourceFile, at);
      if (!metadata) return [];
      state.sessionId = metadata.id;
      actions.push({ type: 'session', metadata });
    }

    if (record.type === 'user') {
      const prompt = humanPrompt(record);
      if (prompt === undefined) return actions;
      if (state.currentTurnId) {
        actions.push({ type: 'turn-end', turnId: state.currentTurnId, sessionId: state.sessionId, at, status: 'completed' });
      }
      state.currentTurnId = `claude:${stringValue(record.promptId) || stringValue(record.uuid) || at}`;
      state.currentModel = null;
      actions.push(
        { type: 'turn-start', turnId: state.currentTurnId, sessionId: state.sessionId, at },
        { type: 'turn-title', turnId: state.currentTurnId, clientId: null, title: prompt },
      );
      return actions;
    }

    const message = record.message || {};
    const usage = message.usage;
    const model = stringValue(message.model);
    if (!usage || !model || model === '<synthetic>') return actions;

    // Transcripts resumed mid-conversation can start without a prompt record.
    if (!state.currentTurnId) {
      state.currentTurnId = `claude:${state.sessionId}:${stringValue(record.uuid) || at}`;
      state.currentModel = null;
      actions.push({ type: 'turn-start', turnId: state.currentTurnId, sessionId: state.sessionId, at });
    }
    const effort = stringValue(record.effort) || state.currentEffort;
    if (model !== state.currentModel || effort !== state.currentEffort) {
      state.currentModel = model;
      state.currentEffort = effort;
      actions.push({ type: 'turn-context', turnId: state.currentTurnId, sessionId: state.sessionId, model, effort, at });
    }

    const input = integerValue(usage.input_tokens);
    const cacheRead = integerValue(usage.cache_read_input_tokens);
    const cacheWrite = integerValue(usage.cache_creation_input_tokens);
    const output = integerValue(usage.output_tokens);
    const messageId = stringValue(message.id);
    actions.push({
      type: 'call',
      provider: 'claude',
      // Streaming writes one line per content block with the same message ID; the
      // database keeps the largest usage so duplicates and resumed copies count once.
      eventId: messageId ? `claude:${messageId}:${stringValue(record.requestId) || ''}` : null,
      turnId: state.currentTurnId,
      sessionId: state.sessionId,
      at,
      model,
      effort,
      // Codex semantics: input includes cached and cache-write tokens.
      inputTokens: input + cacheRead + cacheWrite,
      cachedInputTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cacheWrite1hTokens: Math.min(cacheWrite, integerValue(usage.cache_creation?.ephemeral_1h_input_tokens)),
      outputTokens: output,
      reasoningTokens: integerValue(usage.output_tokens_details?.thinking_tokens),
      totalTokens: input + cacheRead + cacheWrite + output,
      excluded: false,
    });

    if (TURN_END_REASONS.has(message.stop_reason)) {
      actions.push({ type: 'turn-end', turnId: state.currentTurnId, sessionId: state.sessionId, at, status: 'completed' });
    }
    return actions;
  },
};

function sessionMetadata(record, sourceFile, at) {
  const recordSessionId = stringValue(record.sessionId);
  if (!recordSessionId) return null;
  const directory = path.dirname(sourceFile);
  const isSubagent = path.basename(directory).toLowerCase() === 'subagents';
  if (!isSubagent) {
    return {
      id: recordSessionId,
      provider: 'claude',
      parentSessionId: null,
      startedAt: at,
      cwd: stringValue(record.cwd),
      originator: stringValue(record.entrypoint),
      threadSource: 'user',
      agentNickname: null,
      agentRole: null,
      depth: 0,
      sourceFile,
    };
  }

  const agentId = stringValue(record.agentId) || path.basename(sourceFile, '.jsonl').replace(/^agent-/, '');
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(sourceFile.replace(/\.jsonl$/i, '.meta.json'), 'utf8')) || {};
  } catch {
    // Older Claude Code versions do not write subagent metadata.
  }
  return {
    id: `${recordSessionId}/agent-${agentId}`,
    provider: 'claude',
    parentSessionId: recordSessionId,
    startedAt: at,
    cwd: stringValue(record.cwd),
    originator: stringValue(record.entrypoint),
    threadSource: 'subagent',
    agentNickname: stringValue(meta.description),
    agentRole: stringValue(meta.agentType),
    depth: 1,
    sourceFile,
  };
}

// Returns the prompt title for a human-authored message, or undefined for tool results,
// meta records, and interruption markers.
function humanPrompt(record) {
  if (record.isMeta || record.isCompactSummary || record.toolUseResult) return undefined;
  const content = record.message?.content;
  let text;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((block) => block?.type === 'tool_result')) return undefined;
    const texts = content.filter((block) => block?.type === 'text').map((block) => block.text);
    if (!texts.length && !content.some((block) => block?.type === 'image')) return undefined;
    text = texts.join(' ');
  } else {
    return undefined;
  }
  if (/^\s*\[Request interrupted/i.test(text)) return undefined;
  const command = text.match(/<command-name>([\s\S]*?)<\/command-name>/i);
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/i);
  if (command) return compactTitle(`${command[1].trim()} ${args ? args[1] : ''}`);
  // Injected context blocks (<system-reminder>, <task-notification>, ...) are not part of the prompt.
  return compactTitle(text.replace(/<([a-z]+[-_][a-z_-]+)>[\s\S]*?<\/\1>/gi, ' ')) || (text ? null : '(image)');
}
