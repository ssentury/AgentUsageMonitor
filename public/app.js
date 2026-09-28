const turnList = document.querySelector('#turn-list');
const summary = document.querySelector('#summary');
const days = document.querySelector('#days');
const provider = document.querySelector('#provider');
const limits = document.querySelector('#limits');
const listPeriod = document.querySelector('#list-period');
const updatedAt = document.querySelector('#updated-at');
const connection = document.querySelector('#connection');
const liveDot = document.querySelector('#live-dot');
const rescan = document.querySelector('#rescan');
let refreshTimer;

days.addEventListener('change', refresh);
provider.addEventListener('change', refresh);
rescan.addEventListener('click', async () => {
  rescan.disabled = true;
  await fetch('/api/rescan', { method: 'POST' });
  setTimeout(() => {
    rescan.disabled = false;
    refresh();
  }, 500);
});

const events = new EventSource('/api/events');
events.addEventListener('ready', markConnected);
events.addEventListener('update', () => {
  markConnected();
  scheduleRefresh(100);
});
events.onerror = () => {
  connection.textContent = 'Reconnecting';
  liveDot.classList.remove('connected');
};

setInterval(refresh, 10_000);
refresh();

async function refresh() {
  try {
    listPeriod.textContent = days.selectedOptions[0]?.textContent || 'Today';
    const query = `days=${encodeURIComponent(days.value)}&provider=${encodeURIComponent(provider.value)}`;
    const [turnResponse, summaryResponse, catalogResponse, taskbarResponse] = await Promise.all([
      fetch(`/api/turns?${query}&limit=150`, { cache: 'no-store' }),
      fetch(`/api/summary?${query}`, { cache: 'no-store' }),
      fetch('/api/catalog', { cache: 'no-store' }),
      fetch('/api/taskbar', { cache: 'no-store' }),
    ]);
    if (!turnResponse.ok || !summaryResponse.ok) throw new Error('Could not load usage data.');
    const turnPayload = await turnResponse.json();
    renderSummary(await summaryResponse.json());
    if (taskbarResponse.ok) renderLimits((await taskbarResponse.json()).providers);
    renderTurns(turnPayload.turns);
    if (catalogResponse.ok) {
      const catalog = await catalogResponse.json();
      const missing = catalog.models.filter((row) => !row.priced).length;
      const link = document.querySelector('#model-prices');
      link.textContent = missing ? `Model prices · ${missing} missing` : 'Model prices';
      link.classList.toggle('missing', missing > 0);
    }
    updatedAt.textContent = `Updated ${new Date().toLocaleTimeString('en-US')}`;
    markConnected();
  } catch (error) {
    turnList.replaceChildren(element('div', 'empty error', error.message));
  }
}

function scheduleRefresh(delay) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delay);
}

function markConnected() {
  connection.textContent = 'Live';
  liveDot.classList.add('connected');
}

function renderSummary(data) {
  const values = [
    ['Calls', formatNumber(data.calls)],
    ['Input tokens', formatTokens(data.inputTokens)],
    ['Cached input', formatTokens(data.cachedInputTokens)],
    ['API-equivalent cost', `$${formatMoney(data.usd)}${data.unpricedCalls ? ' + unpriced' : ''}`],
  ];
  // Credits only exist for Codex plans.
  if (provider.value !== 'claude') {
    values.push(['Codex credits', `${formatMoney(data.credits)}${data.unpricedCalls ? ' + unpriced' : ''}`]);
  }
  summary.replaceChildren(
    ...values.map(([label, value]) => {
      const item = element('div', 'metric');
      item.append(element('span', 'metric-label', label), element('strong', 'metric-value', value));
      return item;
    }),
  );
}

function renderLimits(providers) {
  const visible = providers.filter((item) => item.hasUsage && (!provider.value || item.id === provider.value));
  limits.replaceChildren(...visible.map((item) => {
    const card = element('div', 'limit-card');
    const head = element('div', 'limit-head');
    head.append(
      element('span', `provider-badge ${item.id}`, item.label),
      element('span', 'limit-cost', `$${formatMoney(item.usdPer30s)}/30s · today $${formatMoney(item.todayUsd)}`),
    );
    card.append(head);
    for (const limit of item.limits) {
      const row = element('div', `limit-row ${limit.stale ? 'stale' : ''}`);
      const bar = element('div', 'limit-bar');
      const fill = element('span', limit.usedPercent >= 80 ? 'high' : limit.usedPercent >= 60 ? 'mid' : '');
      fill.style.width = `${Math.min(100, Math.max(0, limit.usedPercent))}%`;
      bar.append(fill);
      row.append(
        element('span', 'limit-window', limit.window),
        bar,
        element('span', 'limit-value', `${Math.round(limit.usedPercent)}%`),
        element('span', 'limit-reset', limit.resetsAt ? `resets ${formatTime(limit.resetsAt)}` : ''),
      );
      card.append(row);
    }
    if (item.limitStatus !== 'ok' && item.limitMessage) card.append(element('p', 'limit-note', item.limitMessage));
    else if (!item.limits.length) card.append(element('p', 'limit-note', 'No plan usage reported yet.'));
    return card;
  }));
}

function renderTurns(turns) {
  if (!turns.length) {
    turnList.replaceChildren(element('div', 'empty', 'No prompts found for this period.'));
    return;
  }
  turnList.replaceChildren(...turns.map(renderTurn));
}

function renderTurn(turn) {
  const card = element('article', `turn-card ${turn.status === 'running' ? 'running' : ''}`);
  const head = element('div', 'turn-head');
  const left = element('div');
  const title = element('div', 'turn-title');
  if (turn.status === 'running') title.append(element('span', 'status', '● Running'));
  title.append(element('span', `provider-badge ${turn.provider}`, turn.provider === 'claude' ? 'Claude' : 'Codex'));
  title.append(document.createTextNode(turn.title || '(Untitled prompt)'));
  left.append(title, element('div', 'turn-meta', `${formatTime(turn.started_at)} · ${shortPath(turn.cwd)}`));
  const total = element('div', 'turn-total');
  total.append(
    element('div', '', `${formatTokens(turn.totals.totalTokens)} tokens · ${turn.totals.calls} calls`),
    element('div', '', `$${formatMoney(turn.totals.usd)}${turn.provider === 'codex' ? ` · ${formatMoney(turn.totals.credits)} credits` : ''}${turn.totals.hasUnpriced ? ' + unpriced' : ''}`),
  );
  head.append(left, total);
  card.append(head);

  const rows = element('div', 'rows');
  for (const model of turn.models) {
    const row = element('div', 'usage-row');
    const label = element('div', 'model', model.model);
    if (model.effort) label.append(element('span', 'effort', ` · ${model.effort}`));
    row.append(
      label,
      element('div', 'tokens', `${formatTokens(model.inputTokens)} / ${formatTokens(model.cachedInputTokens)} / ${formatTokens(model.outputTokens)} / ${formatTokens(model.totalTokens)}`),
      element('div', 'money', model.usd == null ? 'Unpriced' : `$${formatMoney(model.usd)}`),
      element('div', 'money', model.credits == null ? (model.usd == null ? 'Unpriced' : '—') : formatMoney(model.credits)),
    );
    rows.append(row);
  }
  card.append(rows);

  for (const child of turn.children) {
    const childRow = element('div', 'child');
    const name = child.agentNickname || child.agentRole || 'subagent';
    childRow.append(
      element('div', 'child-line', ''),
    );
    childRow.firstChild.append(
      element('span', 'child-name', `↳ ${name} · ${child.model || 'unknown'}${child.effort ? ` · ${child.effort}` : ''}`),
      element('span', 'tokens', `${formatTokens(child.totalTokens)} · $${formatMoney(child.usd)}`),
    );
    card.append(childRow);
  }
  return card;
}

function element(tag, className = '', text = '') {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== '') value.textContent = text;
  return value;
}

function formatTokens(value = 0) {
  const number = Number(value) || 0;
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return formatNumber(number);
}

function formatNumber(value = 0) {
  return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

function formatMoney(value = 0) {
  return (Number(value) || 0).toFixed(3);
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString('en-US') : '-';
}

function shortPath(value) {
  if (!value) return '-';
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(' / ');
}
