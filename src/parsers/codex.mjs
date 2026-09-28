import { compactTitle, integerValue, normalizeTimestamp, stringValue, windowLabel } from './common.mjs';

export const AUTO_REVIEW_MODEL = 'codex-auto-review';

// Parses Codex Desktop/CLI rollout JSONL (~/.codex/sessions).
export const codexParser = {
  provider: 'codex',
  createState,
  parse(record, state, sourceFile) {
    const actions = [];
    const metadata = sessionMetadata(record, sourceFile);
    if (metadata) {
      state.sessionId = metadata.id;
      actions.push({ type: 'session', metadata });
    }
    actions.push(...applyRecord(record, state));
    return actions;
  },
};

export function sessionMetadata(record, sourceFile) {
  if (record?.type !== 'session_meta') return null;
  const payload = record.payload || {};
  const id = stringValue(payload.id || payload.session_id);
  if (!id) return null;

  const source = payload.source;
  const spawn = source?.subagent?.thread_spawn;
  const inheritedParent = stringValue(payload.session_id) !== id ? stringValue(payload.session_id) : null;
  const parentSessionId = stringValue(spawn?.parent_thread_id) || inheritedParent;

  return {
    id,
    provider: 'codex',
    parentSessionId,
    startedAt: normalizeTimestamp(record.timestamp || payload.timestamp),
    cwd: stringValue(payload.cwd),
    originator: stringValue(payload.originator),
    threadSource: stringValue(payload.thread_source) || (parentSessionId ? 'subagent' : 'user'),
    agentNickname: stringValue(spawn?.agent_nickname),
    agentRole: stringValue(spawn?.agent_role) || stringValue(source?.subagent?.other),
    depth: integerValue(spawn?.depth, parentSessionId ? 1 : 0),
    sourceFile,
  };
}

export function applyRecord(record, state) {
  if (!record || !state.sessionId) return [];
  const payload = record.payload || {};
  const timestamp = normalizeTimestamp(record.timestamp);
  const actions = [];

  if (record.type === 'turn_context') {
    state.currentTurnId = stringValue(payload.turn_id) || state.currentTurnId;
    state.currentModel = stringValue(payload.model) || state.currentModel;
    state.currentEffort = stringValue(payload.effort) || state.currentEffort;
    if (state.currentTurnId) {
      actions.push({
        type: 'turn-context',
        turnId: state.currentTurnId,
        sessionId: state.sessionId,
        model: state.currentModel,
        effort: state.currentEffort,
        at: timestamp,
      });
    }
    return actions;
  }

  if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
    const metadata = payload.internal_chat_message_metadata_passthrough || {};
    const contentKinds = Array.isArray(metadata.content_item_kinds) ? metadata.content_item_kinds : [];
    const message = Array.isArray(payload.content)
      ? payload.content
          .filter(
            (item, index) =>
              item?.type === 'input_text' &&
              (contentKinds.length === 0 || contentKinds[index] === 'user.text'),
          )
          .map((item) => item.text)
          .join(' ')
      : null;
    const turnId = stringValue(metadata.turn_id) || state.currentTurnId;
    if (turnId) {
      actions.push({
        type: 'turn-title',
        turnId,
        clientId: null,
        title: summarizeMessage(message),
      });
    }
    return actions;
  }

  if (record.type !== 'event_msg') return actions;

  if (payload.type === 'task_started') {
    state.currentTurnId = stringValue(payload.turn_id) || state.currentTurnId;
    if (state.currentTurnId) {
      actions.push({
        type: 'turn-start',
        turnId: state.currentTurnId,
        sessionId: state.sessionId,
        at: timestamp,
      });
    }
  } else if (payload.type === 'user_message' && state.currentTurnId) {
    actions.push({
      type: 'turn-title',
      turnId: state.currentTurnId,
      clientId: stringValue(payload.client_id),
      title: summarizeMessage(payload.message),
    });
  } else if (payload.type === 'token_count') {
    // Plan usage is reported with every token event, independent of the current turn.
    actions.push(...rateLimitActions(payload.rate_limits, timestamp));
    const usage = payload.info?.last_token_usage;
    if (usage && state.currentTurnId) {
      actions.push({
        type: 'call',
        provider: 'codex',
        turnId: state.currentTurnId,
        sessionId: state.sessionId,
        at: timestamp,
        model: state.currentModel || 'unknown',
        effort: state.currentEffort,
        inputTokens: integerValue(usage.input_tokens),
        cachedInputTokens: integerValue(usage.cached_input_tokens),
        cacheWriteTokens: integerValue(usage.cache_write_input_tokens),
        cacheWrite1hTokens: 0,
        outputTokens: integerValue(usage.output_tokens),
        reasoningTokens: integerValue(usage.reasoning_output_tokens),
        totalTokens: integerValue(usage.total_tokens),
        excluded: state.currentModel === AUTO_REVIEW_MODEL,
      });
    }
  } else if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
    const turnId = stringValue(payload.turn_id) || state.currentTurnId;
    if (turnId) {
      actions.push({
        type: 'turn-end',
        turnId,
        sessionId: state.sessionId,
        at: timestamp,
        status: payload.type === 'task_complete' ? 'completed' : 'aborted',
      });
    }
    if (turnId === state.currentTurnId) state.currentTurnId = null;
  }

  return actions;
}

export function createParserState(saved = {}) {
  return createState(saved);
}

function createState(saved = {}) {
  return {
    sessionId: saved.sessionId || null,
    currentTurnId: saved.currentTurnId || null,
    currentModel: saved.currentModel || null,
    currentEffort: saved.currentEffort || null,
  };
}

function rateLimitActions(limits, at) {
  // Only the main Codex bucket is shown; model-specific buckets use other limit IDs.
  if (!limits || typeof limits !== 'object' || (limits.limit_id && limits.limit_id !== 'codex')) return [];
  const actions = [];
  for (const slot of [limits.primary, limits.secondary]) {
    const usedPercent = Number(slot?.used_percent);
    if (!slot || !Number.isFinite(usedPercent)) continue;
    const windowMinutes = integerValue(slot.window_minutes, 0);
    actions.push({
      type: 'rate-limit',
      provider: 'codex',
      window: windowLabel(windowMinutes),
      usedPercent,
      windowMinutes,
      resetsAt: Number.isFinite(Number(slot.resets_at)) ? normalizeTimestamp(Number(slot.resets_at)) : null,
      at,
    });
  }
  return actions;
}

function summarizeMessage(value) {
  if (typeof value !== 'string') return null;
  const requestHeading = value.match(/(?:^|\n)#{1,6}\s*My request:\s*(?:\n|$)/i);
  const prompt = requestHeading ? value.slice(requestHeading.index + requestHeading[0].length) : value;
  return compactTitle(
    prompt
      .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
      .replace(/<image[\s\S]*?<\/image>/gi, ' '),
  );
}
