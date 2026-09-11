const PROVIDERS = [
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'mimo', name: 'Mimo', usageOnly: true },
];

const PROVIDER_NAMES = new Map(PROVIDERS.map(({ id, name }) => [id, name]));
const PERIOD_LABELS = { today: 'today', week: 'this week', month: 'this month' };
const COLLECTOR_LABELS = {
  collecting: 'Collecting',
  disconnected: 'Disconnected',
  error: 'Collection error',
  unconfigured: 'Not configured',
};
const OUTCOME_LABELS = { success: 'OK', ok: 'OK', failed: 'Failed', error: 'Failed' };

const POLL_MS = 5000;
const TIME_ZONE = 'America/Chicago';

const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const stampFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const exactFormat = new Intl.NumberFormat('en-US');
const costFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dom = {
  tracking: document.getElementById('tracking'),
  updated: document.getElementById('updated'),
  collector: document.getElementById('collector'),
  collectorText: document.getElementById('collector-text'),
  banner: document.getElementById('banner'),
  demo: document.getElementById('demo'),
  providers: document.getElementById('providers'),
  feedList: document.getElementById('feed-list'),
  feedEmpty: document.getElementById('feed-empty'),
  feedTitle: document.getElementById('feed-title'),
  settings: document.getElementById('settings'),
  settingsButton: document.getElementById('settings-button'),
  fullscreenButton: document.getElementById('fullscreen-button'),
  apiKey: document.getElementById('api-key'),
  applyKey: document.getElementById('apply-key'),
  clearKey: document.getElementById('clear-key'),
  keyStatus: document.getElementById('key-status'),
  feedFilter: document.getElementById('feed-filter'),
};

const API_KEY_STORAGE = 'cliproxyapi-monitor.api-key';

const PROVIDER_SELECTION_KEY = 'cliproxyapi-monitor.providers';
const DEFAULT_PROVIDER_IDS = ['antigravity', 'claude', 'codex'];

function readProviderSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROVIDER_SELECTION_KEY));
    if (Array.isArray(saved) && saved.length === DEFAULT_PROVIDER_IDS.length) {
      return saved.map((id, slot) => PROVIDER_NAMES.has(id) ? id : DEFAULT_PROVIDER_IDS[slot]);
    }
  } catch {
    // Missing or unavailable browser storage keeps the default cards usable.
  }
  return [...DEFAULT_PROVIDER_IDS];
}

function setCardFlipped(record, open, focus = false) {
  record.front.inert = open;
  record.picker.inert = !open;
  record.front.setAttribute('aria-hidden', String(open));
  record.picker.setAttribute('aria-hidden', String(!open));
  record.changeButton.setAttribute('aria-expanded', String(open));
  record.card.classList[open ? 'add' : 'remove']('is-flipped');
  if (open && focus) record.options.get(selectedProviders[record.slot]).focus();
  if (!open && (focus || record.picker.contains(document.activeElement))) record.changeButton.focus();
}

function selectCardProvider(record, id) {
  selectedProviders[record.slot] = id;
  try {
    localStorage.setItem(PROVIDER_SELECTION_KEY, JSON.stringify(selectedProviders));
  } catch {
    // The choice still works for this session when storage is unavailable.
  }
  renderProviders(view);
  setCardFlipped(record, false, true);
}


const cards = new Map();
let selectedProviders = readProviderSelection();

let period = 'today';
// Only this opaque hash leaves the browser. The raw key stays in localStorage.
let caller = null;
let filterReady = false;
let filterBusy = false;
let filterMessage = '';
let token = 0;
let inFlight = null;
let timer = null;
let view = null;
let lastError = null;
let lastGoodAt = null;
let feedSignature = null;
let touchingFeed = false;
let pendingFeed = null;

/* ---------- helpers ---------- */

async function hashApiKey(key) {
  if (!globalThis.crypto?.subtle) throw new Error('Use HTTPS or localhost to apply your API-key filter.');
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').slice(0, 16);
}

async function applyApiKey(clear = false) {
  if (filterBusy) return;
  const key = clear ? '' : dom.apiKey.value.trim();
  if (!clear && !key) {
    filterMessage = 'Paste an API key, or choose Clear filter to show all usage.';
    renderSettings();
    dom.apiKey.focus();
    return;
  }
  filterBusy = true;
  filterMessage = '';
  renderSettings();
  try {
    const next = key ? await hashApiKey(key) : null;
    try {
      if (key) localStorage.setItem(API_KEY_STORAGE, key);
      else localStorage.removeItem(API_KEY_STORAGE);
    } catch {
      throw new Error('Browser storage is unavailable. Allow site storage and try again.');
    }
    dom.apiKey.value = key;
    caller = next;
    filterReady = true;
    // Never present the previous key's figures while the new request is pending.
    view = null;
    lastGoodAt = null;
    lastError = null;
    feedSignature = null;
    pendingFeed = null;
    touchingFeed = false;
    restart();
  } catch (error) {
    filterMessage = error.message;
  } finally {
    filterBusy = false;
    renderSettings();
  }
}

async function initializeFilter() {
  filterBusy = true;
  renderSettings();
  try {
    let key;
    try { key = localStorage.getItem(API_KEY_STORAGE)?.trim() || ''; }
    catch { throw new Error('Cannot read your saved filter. Allow site storage, then apply or clear the filter in Settings.'); }
    dom.apiKey.value = key;
    caller = key ? await hashApiKey(key) : null;
    filterReady = true;
    render();
    load();
  } catch (error) {
    filterMessage = error.message;
    render();
  } finally {
    filterBusy = false;
    renderSettings();
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function parseTime(value) {
  if (typeof value !== 'string' || value === '') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function ageText(at) {
  if (at === null) return null;
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function shortTime(at) {
  return Date.now() - at < 86400000 ? timeFormat.format(at) : stampFormat.format(at);
}

function resetText(next, latest) {
  if (next === null && latest === null) return '';
  if (next === null || latest === null || latest - next <= 60000) return `Next account reset ${shortTime(next ?? latest)}`;
  const tail = dayFormat.format(latest) === dayFormat.format(next) ? timeFormat.format(latest) : stampFormat.format(latest);
  return `Next account reset ${shortTime(next)} · last ${tail}`;
}

function exactText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? exactFormat.format(value) : 'Unknown';
}

function compactText(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? compactFormat.format(value)
    : 'n/a';
}

function durationText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

function costText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  if (value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  return value < 100 ? costFormat.format(value) : '$' + compactFormat.format(value);
}

function percentText(value) {
  return `${value < 10 && value > 0 ? value.toFixed(1) : Math.round(value)}%`;
}

/* ---------- counters ----------
   Every changing figure tweens from its previous value to the new one so a
   refresh reads as movement instead of a swap. Each element keeps its own
   numeric value and formatter; a tween already in flight is retargeted. */

const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const COUNT_MS = 700;
const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;

function setCount(node, value, format) {
  const known = typeof value === 'number' && Number.isFinite(value);
  const previous = node.count;
  node.count = known ? value : null;
  if (!known || previous === undefined || previous === null || REDUCED_MOTION || raf === null || previous === value) {
    node.textContent = known ? format(value) : format(null);
    node.dataset.unknown = String(!known);
    return;
  }
  node.dataset.unknown = 'false';
  node.classList.add('is-counting');
  const from = node.tweenValue ?? previous;
  const started = performance.now();
  const tick = (now) => {
    if (node.count !== value) return; // retargeted by a newer call
    const t = Math.min(1, (now - started) / COUNT_MS);
    const eased = 1 - Math.pow(1 - t, 4);
    node.tweenValue = from + (value - from) * eased;
    node.textContent = format(t === 1 ? value : node.tweenValue);
    if (t < 1) raf(tick);
    else { node.tweenValue = undefined; node.classList.remove('is-counting'); }
  };
  raf(tick);
}

function percentState(remaining) {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return 'unknown';
  if (remaining <= 0) return 'empty';
  if (remaining < 25) return 'low';
  return 'ok';
}

/* ---------- provider summaries ---------- */


function buildCard({ id, name }, slot) {
  const card = el('article', 'provider-slot');
  const front = el('div', 'provider provider-front');
  const head = el('header', 'provider-head');
  const heading = el('h2', null, name);
  const periodLabel = el('span', 'provider-period');
  const changeButton = el('button', 'tool provider-change', '↔');
  changeButton.type = 'button';
  changeButton.setAttribute('aria-label', `Change provider for card ${slot + 1}`);
  changeButton.setAttribute('aria-expanded', 'false');
  changeButton.setAttribute('aria-controls', `provider-picker-${slot}`);
  changeButton.title = 'Change provider';
  const actions = el('div', 'provider-actions');
  actions.append(periodLabel, changeButton);
  head.append(heading, actions);

  const stats = {};
  const totals = el('div', 'totals');
  for (const [key, text] of [['requests', 'Requests'], ['tokens', 'Tokens'], ['cacheHit', 'Cache hit']]) {
    const value = el('span', 'stat-value', 'Unknown');
    value.dataset.unknown = 'true';
    const label = el('span', 'stat-label', text);
    const stat = el('div', 'stat');
    stat.append(value, label);
    totals.append(stat);
    stats[key] = { value, label, stat };
  }
  const details = el('div', 'details');
  for (const [key, text] of [['inputTokens', 'Input'], ['outputTokens', 'Output'], ['costUsd', 'Est. cost']]) {
    const value = el('span', 'detail-value', 'n/a');
    value.dataset.unknown = 'true';
    const label = el('span', 'detail-label', text);
    const stat = el('div', 'detail');
    stat.append(label, value);
    details.append(stat);
    stats[key] = { value, label, stat };
  }
  const windows = el('div', 'windows');
  const windowsHead = el('div', 'windows-head');
  const quotaUpdated = el('span', 'quota-updated');
  windowsHead.append(el('span', null, 'Remaining quota'), quotaUpdated);
  const note = el('p', 'note');
  note.hidden = true;
  const modelBreakdown = el('div', 'model-breakdown');
  modelBreakdown.tabIndex = 0;
  modelBreakdown.setAttribute('role', 'region');
  const modelTable = el('table', 'model-table');
  const modelHead = el('thead');
  const modelColumns = el('tr');
  for (const label of ['Model', 'Tokens', 'Est. cost']) {
    const column = el('th', null, label);
    column.setAttribute('scope', 'col');
    modelColumns.append(column);
  }
  modelHead.append(modelColumns);
  const modelRows = el('tbody');
  modelTable.append(modelHead, modelRows);
  const modelEmpty = el('p', 'model-empty', 'Awaiting usage data…');
  modelBreakdown.append(modelTable, modelEmpty);
  front.append(head, totals, details, windowsHead, windows, note, modelBreakdown);

  const picker = el('div', 'provider-picker');
  picker.id = `provider-picker-${slot}`;
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', `Choose provider for card ${slot + 1}`);
  picker.setAttribute('aria-hidden', 'true');
  picker.inert = true;
  const pickerHead = el('div', 'picker-head');
  const closeButton = el('button', 'tool', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', `Close provider picker for card ${slot + 1}`);
  pickerHead.append(el('h2', null, 'Choose provider'), closeButton);
  const choices = el('div', 'provider-choices');
  const options = new Map();
  const record = { card, front, picker, heading, changeButton, options, slot, providerId: id,
    periodLabel, stats, totals, details, windowsHead, quotaUpdated, windows, note,
    modelBreakdown, modelTable, modelRows, modelEmpty, modelSignature: null, modelScope: null,
    windowIds: '', windowNodes: new Map() };
  for (const provider of PROVIDERS) {
    const button = el('button', 'provider-choice', provider.name);
    button.type = 'button';
    button.dataset.provider = provider.id;
    button.setAttribute('aria-label', provider.name);
    button.setAttribute('aria-pressed', String(provider.id === id));
    button.addEventListener('click', () => selectCardProvider(record, provider.id));
    choices.append(button);
    options.set(provider.id, button);
  }
  picker.append(pickerHead, el('p', 'picker-note', 'Choose what this card shows.'), choices);
  card.append(front, picker);
  front.dataset.provider = id;

  changeButton.addEventListener('click', () => setCardFlipped(record, true, true));
  closeButton.addEventListener('click', () => setCardFlipped(record, false, true));
  card.addEventListener('pointerenter', event => {
    if (event.pointerType === 'mouse' && !front.contains(document.activeElement)) setCardFlipped(record, true);
  });
  card.addEventListener('pointerleave', () => {
    if (!picker.contains(document.activeElement)) setCardFlipped(record, false);
  });
  card.addEventListener('focusout', event => {
    if (!card.contains(event.relatedTarget)) setCardFlipped(record, false);
  });
  card.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setCardFlipped(record, false, true);
    }
  });
  cards.set(slot, record);
  dom.providers.append(card);
  return record;
}

function buildWindow() {
  const window = el('div', 'window');
  const head = el('div', 'window-head');
  const label = el('span', 'window-label');
  const stale = el('span', 'tag', 'stale');
  stale.hidden = true;
  const value = el('span', 'window-value');
  head.append(label, stale, value);

  const bar = el('div', 'bar');
  const fill = el('div', 'bar-fill');
  bar.append(fill);

  const coverage = el('span', 'coverage');
  coverage.hidden = true;
  head.append(coverage);
  const message = el('p', 'window-message');

  window.append(head, bar, message);
  return { window, label, stale, value, bar, fill, coverage, message };
}

function updateWindow(node, entry) {
  const state = percentState(entry.remainingPercent);
  node.window.dataset.state = state;
  node.label.textContent = entry.model && entry.model !== 'all' ? `${entry.label || entry.id} · ${entry.model}` : String(entry.label || entry.id || 'Quota');

  const known = state !== 'unknown';
  setCount(node.value, known ? entry.remainingPercent : null, v => (v === null ? 'Unknown' : `${Math.round(v)}%`));
  const pct = known ? String(Math.max(0, Math.min(100, entry.remainingPercent))) : '0';
  if (node.pct !== undefined && node.pct !== pct) {
    // Restart the change flash even if the previous one is still running.
    node.window.classList.remove('is-bump');
    void node.window.offsetWidth;
    node.window.classList.add('is-bump');
  }
  node.pct = pct;
  node.fill.style.setProperty('--pct', pct);
  node.stale.hidden = entry.stale !== true;

  const observedAt = parseTime(entry.observedAt);
  const age = ageText(observedAt);
  const observed = Number.isFinite(entry.observedAccounts) ? entry.observedAccounts : 0;
  const total = Number.isFinite(entry.totalAccounts) ? entry.totalAccounts : 0;
  const coverage = `${observed} of ${total} accounts`;
  // The chart carries the reading; only partial coverage earns a visible note.
  const partial = total > 0 && observed < total;
  node.coverage.textContent = partial ? `${observed} of ${total}` : '';
  node.coverage.hidden = !partial;

  const reset = resetText(parseTime(entry.nextResetAt), parseTime(entry.latestResetAt));
  node.bar.title = [reset, age ? `Read ${age}` : ''].filter(Boolean).join(' · ');
  node.message.textContent = entry.message || '';
  node.message.hidden = !entry.message;

  node.window.setAttribute(
    'aria-label',
    known
      ? `${node.label.textContent}: ${Math.round(entry.remainingPercent)} percent remaining, ${coverage}${age ? `, read ${age}` : ''}${entry.stale === true ? ', stale' : ''}`
      : `${node.label.textContent}: remaining capacity Unknown, ${coverage}`,
  );
}

function renderModelUsage(card, totals) {
  const models = Array.isArray(totals?.models) ? totals.models : null;
  const scope = JSON.stringify([card.providerId, period, caller]);
  const signature = JSON.stringify([scope, models, totals?.tokens]);
  if (signature === card.modelSignature) return;
  const scrollTop = scope === card.modelScope ? card.modelBreakdown.scrollTop : 0;
  card.modelSignature = signature;
  card.modelScope = scope;
  const name = PROVIDER_NAMES.get(card.providerId);
  card.modelBreakdown.setAttribute('aria-label', `${name} model usage for ${PERIOD_LABELS[period]}`);
  card.modelTable.hidden = !models?.length;
  card.modelEmpty.hidden = !!models?.length;
  card.modelEmpty.textContent = totals === null ? 'Awaiting usage data…'
    : models === null ? 'Model breakdown is unavailable.'
    : caller ? 'No model usage for this API key in this period.' : 'No model usage in this period.';
  card.modelRows.replaceChildren(...(models ?? []).map(model => {
    const row = el('tr');
    const modelName = model.model || 'Unknown model';
    const label = el('th', 'model-name', modelName);
    label.setAttribute('scope', 'row');
    label.title = modelName;
    const tokens = typeof model.tokens === 'number' && Number.isFinite(model.tokens) ? model.tokens : null;
    const usage = el('td', 'model-usage');
    usage.append(el('span', null, tokens === null ? 'n/a' : compactText(tokens)));
    if (tokens !== null && totals.tokens > 0) {
      const share = Math.min(100, tokens / totals.tokens * 100);
      const shareLabel = share > 0 && share < 1 ? '<1%' : percentText(share);
      usage.append(el('span', 'model-share', shareLabel));
    }
    usage.title = tokens === null ? 'No token count reported' : `${exactText(tokens)} reported tokens; ${exactText(model.requests)} requests`;
    const cost = typeof model.costUsd === 'number' && Number.isFinite(model.costUsd) ? model.costUsd : null;
    const estimate = el('td', 'model-cost', cost === null ? 'n/a' : costText(cost));
    const partial = cost !== null && model.pricedRequests < model.requests;
    if (partial) estimate.append(el('span', 'model-share', 'partial'));
    estimate.title = cost === null ? 'No priced usage recorded for this model'
      : partial ? `Partial estimate: ${model.pricedRequests} of ${model.requests} requests priced`
      : `About ${costFormat.format(cost)} at list prices`;
    row.append(label, usage, estimate);
    return row;
  }));
  card.modelBreakdown.scrollTop = scrollTop;
}

function renderProviders(payload) {
  for (const [slot, id] of selectedProviders.entries()) {
    const provider = PROVIDERS.find(entry => entry.id === id);
    const card = cards.get(slot) ?? buildCard(provider, slot);
    const providerChanged = card.providerId !== id;
    const usageOnly = provider.usageOnly === true;
    if (card.usageOnly !== usageOnly) {
      card.usageOnly = usageOnly;
      card.front.dataset.usageOnly = String(usageOnly);
      card.totals.replaceChildren(card.stats.requests.stat, card.stats.tokens.stat,
        ...(usageOnly ? [] : [card.stats.cacheHit.stat]));
      card.details.hidden = false;
      card.windowsHead.hidden = usageOnly;
      card.windows.hidden = usageOnly;
    }
    card.providerId = id;
    card.heading.textContent = provider.name;
    card.front.dataset.provider = id;
    for (const [optionId, button] of card.options) button.setAttribute('aria-pressed', String(optionId === id));
    const quota = payload?.quota?.[id] ?? null;
    const matches = payload?.period === period && (payload?.caller ?? null) === caller;
    const totals = matches ? payload?.totals?.[id] ?? null : null;
    // A period or filter switch keeps the last figures on screen until the
    // new ones arrive, so the counters roll from one view to the next.
    const pendingPeriod = payload !== null && !matches;
    const number = raw => (typeof raw === 'number' && Number.isFinite(raw) ? raw : null);

    if (!pendingPeriod || providerChanged) {
      card.periodLabel.textContent = PERIOD_LABELS[period];
      const requests = number(totals?.requests);
      const tokens = number(totals?.tokens);
      setCount(card.stats.requests.value, requests, v => (v === null ? 'Unknown' : exactText(Math.round(v))));
      card.stats.requests.value.title = requests === null ? 'No value recorded' : exactText(requests);
      setCount(card.stats.tokens.value, tokens, v => (v === null ? 'Unknown' : compactText(Math.round(v))));
      card.stats.tokens.value.title = tokens === null ? 'No value recorded' : exactText(tokens);

      for (const key of ['inputTokens', 'outputTokens']) {
        const raw = number(totals?.[key]);
        setCount(card.stats[key].value, raw, v => (v === null ? 'n/a' : compactText(Math.round(v))));
        card.stats[key].value.title = raw === null ? 'No value recorded' : `${exactText(raw)} tokens`;
      }

      // Cache hit rate: cached prompt tokens as a share of all input tokens.
      const input = number(totals?.inputTokens);
      const cached = number(totals?.cachedTokens);
      const prompt = input === null ? null : input + (id === 'claude' ? cached ?? 0 : 0);
      const rate = prompt !== null && cached !== null && prompt > 0 ? Math.max(0, Math.min(100, (cached / prompt) * 100)) : null;
      setCount(card.stats.cacheHit.value, rate, v => (v === null ? 'n/a' : percentText(v)));
      card.stats.cacheHit.value.title = rate === null ? 'No input tokens recorded' : `${exactText(cached)} cached of ${exactText(prompt)} input tokens`;

      const cost = number(totals?.costUsd);
      setCount(card.stats.costUsd.value, cost, v => (v === null ? 'n/a' : costText(v)));
      card.stats.costUsd.value.title = cost === null ? 'No priced usage recorded' : `About ${costFormat.format(cost)} at list prices`;
      renderModelUsage(card, totals);
    }

    const windows = !usageOnly && Array.isArray(quota?.windows) ? quota.windows : [];
    const ids = windows.map(entry => String(entry.id ?? entry.label)).join('|');
    if (ids !== card.windowIds) {
      card.windowIds = ids;
      card.windowNodes.clear();
      card.windows.replaceChildren();
      for (const entry of windows) {
        const node = buildWindow();
        card.windowNodes.set(String(entry.id ?? entry.label), node);
        card.windows.append(node.window);
      }
    }
    for (const entry of windows) {
      const node = card.windowNodes.get(String(entry.id ?? entry.label));
      if (node) updateWindow(node, entry);
    }
    const updatedTimes = windows.map(entry => parseTime(entry.observedAt)).filter(value => value !== null);
    const updatedAt = updatedTimes.length ? Math.min(...updatedTimes) : null;
    const age = ageText(updatedAt);
    card.quotaUpdated.textContent = windows.length ? (age ? 'Updated ' + age : 'Awaiting first reading') : '';
    card.quotaUpdated.title = updatedAt === null ? '' : 'Quota read ' + stampFormat.format(updatedAt);

    const message = payload !== null && !pendingPeriod && !Object.hasOwn(payload.totals ?? {}, id)
      ? (usageOnly ? 'Usage data are not available for this provider from this connection.' : 'Usage and quota data are not available for this provider from this connection.')
      : usageOnly ? '' : typeof quota?.message === 'string' && quota.message
        ? quota.message
      : windows.length === 0
        ? 'Quota not reported yet'
        : '';
    card.note.textContent = message;
    card.note.hidden = !message;
  }
}

/* ---------- live feed ---------- */

function renderFeed(payload) {
  if (touchingFeed) { pendingFeed = payload; return; }
  if (payload !== null && (payload?.caller ?? null) !== caller) return;
  const recent = Array.isArray(payload?.recent) ? payload.recent : [];
  dom.feedEmpty.textContent = caller ? 'No completed requests for this API key.' : 'No completed requests yet.';
  const signature = recent.map(row => `${row.id}`).join('|');
  if (signature === feedSignature) return;
  // Rows already listed last time keep still; only new arrivals animate in. An empty
  // previous list (first paint, or a feed that went quiet) counts as a fresh render.
  const seen = new Set(feedSignature ? feedSignature.split('|') : recent.map(row => String(row.id)));
  feedSignature = signature;

  const scroll = dom.feedList.scrollTop;
  const oldRows = Array.from(dom.feedList.children);
  const anchor = oldRows.find(row => row.offsetTop >= dom.feedList.offsetTop + scroll);
  const anchorId = anchor?.dataset.id;
  const anchorOffset = anchor ? anchor.offsetTop - dom.feedList.offsetTop - scroll : 0;
  dom.feedList.replaceChildren();

  for (const row of recent) {
    const at = parseTime(row.timestamp);
    const item = el('li', 'row');
    item.dataset.id = String(row.id);
    if (!seen.has(String(row.id))) item.classList.add('is-new');

    const time = el('span', 'at', at === null ? 'Unknown' : clockFormat.format(at));
    if (at !== null) time.title = stampFormat.format(at);

    const who = el('span', 'who');
    who.append(el('span', 'prov', PROVIDER_NAMES.get(row.provider) ?? String(row.provider ?? 'Unknown')));
    who.append(el('span', 'model', String(row.model ?? 'Unknown model')));
    if (typeof row.caller === 'string' && row.caller) who.append(el('span', 'caller-tag', row.caller));
    const duration = durationText(row.durationMs);
    if (duration) who.append(el('span', 'dur', duration));

    const cells = [];
    for (const [key, title] of [['inputTokens', 'Input tokens'], ['outputTokens', 'Output tokens'], ['cachedTokens', 'Cached tokens']]) {
      const value = row[key];
      const text = compactText(value);
      const cell = el('span', 'num', text);
      cell.dataset.unknown = String(text === 'n/a');
      cell.title = typeof value === 'number' ? `${title}: ${exactText(value)}` : `${title} not reported`;
      cells.push(cell);
    }
    const costCell = el('span', 'num cost', costText(row.costUsd));
    costCell.dataset.unknown = String(typeof row.costUsd !== 'number');
    costCell.title = typeof row.costUsd === 'number' ? `About ${costFormat.format(row.costUsd)} at list prices` : (row.inputTokens == null && row.outputTokens == null ? 'Token breakdown not reported' : 'No reliable model price match');
    cells.push(costCell);

    const key = OUTCOME_LABELS[row.outcome] ? (row.outcome === 'failed' || row.outcome === 'error' ? 'failed' : 'ok') : 'unknown';
    const result = el('span', 'result');
    result.dataset.result = key;
    result.append(el('span', 'pip'), el('span', null, OUTCOME_LABELS[row.outcome] ?? String(row.outcome ?? 'Unknown')));

    item.append(time, who, ...cells, result);
    dom.feedList.append(item);
  }

  dom.feedList.hidden = recent.length === 0;
  dom.feedEmpty.hidden = recent.length > 0;
  dom.feedList.scrollTop = scroll;
  if (scroll > 0 && anchorId) {
    const nextAnchor = Array.from(dom.feedList.children).find(row => row.dataset.id === anchorId);
    if (nextAnchor) dom.feedList.scrollTop = nextAnchor.offsetTop - dom.feedList.offsetTop - anchorOffset;
  }
}

/* ---------- header and notices ---------- */

function renderHeader() {
  const tracking = parseTime(view?.trackingSince);
  dom.tracking.textContent = tracking === null
    ? 'Tracking since -'
    : `Tracking since ${stampFormat.format(tracking)}`;
  dom.tracking.title = tracking === null ? '' : 'America/Chicago (Central Time)';

  if (lastError) {
    dom.updated.textContent = lastGoodAt === null
      ? 'No reading yet'
      : `Last reading ${clockFormat.format(lastGoodAt)}`;
  } else {
    const generated = parseTime(view?.generatedAt);
    dom.updated.textContent = generated === null ? 'Waiting for the first reading' : `Updated ${clockFormat.format(generated)}`;
  }

  const collector = view?.collector ?? null;
  const state = COLLECTOR_LABELS[collector?.state] ? collector.state : 'unknown';
  dom.collector.dataset.state = state;
  const label = COLLECTOR_LABELS[state] ?? 'Connecting';
  if (dom.collectorText.textContent !== label) dom.collectorText.textContent = label;
  const lastEvent = ageText(parseTime(collector?.lastEventAt));
  dom.collector.title = [collector?.message, lastEvent ? `last event ${lastEvent}` : null]
    .filter(Boolean)
    .join(' - ');

  dom.demo.hidden = view?.demo !== true;
}

function renderSettings() {
  dom.applyKey.disabled = filterBusy;
  dom.clearKey.disabled = filterBusy;
  dom.keyStatus.textContent = filterMessage || (filterBusy ? 'Applying filter…'
    : caller ? 'Showing usage for your saved API key.' : 'Showing usage for all API keys.');
  dom.keyStatus.dataset.error = String(Boolean(filterMessage));
  dom.feedFilter.hidden = caller === null;
}

function renderNotices() {
  if (!filterReady) {
    dom.banner.textContent = filterMessage || 'Loading your saved API-key filter…';
    dom.banner.hidden = false;
    return;
  }
  if (!lastError) {
    dom.banner.hidden = true;
    return;
  }
  const suffix = lastGoodAt === null
    ? 'No reading has arrived yet.'
    : `Showing the last reading from ${clockFormat.format(lastGoodAt)}.`;
  dom.banner.textContent = `Dashboard API unreachable (${lastError}). ${suffix} Retrying every 5 seconds.`;
  dom.banner.hidden = false;
}

function render() {
  renderProviders(view);
  renderFeed(view);
  renderHeader();
  renderSettings();
  renderNotices();
}

/* ---------- polling ---------- */

function schedule(delay = POLL_MS) {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(load, delay);
}

async function load() {
  if (!filterReady || inFlight !== null) return;
  timer = null;
  const mine = token + 1;
  token = mine;
  const requested = period;
  const requestedCaller = caller;
  const controller = new AbortController();
  inFlight = controller;

  let payload = null;
  let failure = null;
  try {
    const query = new URLSearchParams({ period: requested });
    if (requestedCaller !== null) query.set('caller', requestedCaller);
    const response = await fetch(`/api/dashboard?${query}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
  } catch (error) {
    if (controller.signal.aborted) return;
    failure = error instanceof Error && /^HTTP \d{3}$/.test(error.message) ? error.message : 'connection failed';
  } finally {
    if (inFlight === controller) inFlight = null;
  }
  if (mine !== token) return;

  if (failure === null) {
    view = payload;
    lastGoodAt = Date.now();
    lastError = null;
  } else {
    lastError = failure;
  }
  render();
  schedule();
}

function restart() {
  token += 1;
  if (inFlight !== null) {
    inFlight.abort();
    inFlight = null;
  }
  if (timer !== null) clearTimeout(timer);
  timer = null;
  render();
  load();
}

function selectPeriod(next) {
  if (!Object.hasOwn(PERIOD_LABELS, next) || next === period) return;
  period = next;
  for (const button of document.querySelectorAll('.periods button')) {
    button.setAttribute('aria-pressed', String(button.dataset.period === period));
  }
  restart();
}

/* ---------- toolbar ---------- */

function syncFullscreen() {
  const active = Boolean(document.fullscreenElement);
  dom.fullscreenButton.setAttribute('aria-pressed', String(active));
  const label = active ? 'Exit full screen' : 'Enter full screen';
  dom.fullscreenButton.setAttribute('aria-label', label);
  dom.fullscreenButton.title = label;
}

dom.fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // The browser refused (no user gesture, embedded frame, or unsupported); the button state stays honest.
  }
  syncFullscreen();
});
document.addEventListener('fullscreenchange', syncFullscreen);
if (typeof document.fullscreenEnabled === 'boolean' && !document.fullscreenEnabled) dom.fullscreenButton.hidden = true;

dom.settingsButton.addEventListener('click', () => {
  if (dom.settings.open) { dom.settings.close(); return; }
  dom.settings.showModal();
  dom.apiKey.focus();
});
dom.applyKey.addEventListener('click', () => applyApiKey());
dom.clearKey.addEventListener('click', () => applyApiKey(true));
dom.apiKey.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); applyApiKey(); }
});
dom.settings.addEventListener('close', () => dom.settingsButton.setAttribute('aria-expanded', 'false'));
dom.settings.addEventListener('click', event => {
  // A click on the backdrop lands on the dialog itself, not the form.
  if (event.target === dom.settings) dom.settings.close();
});
new MutationObserver(() => dom.settingsButton.setAttribute('aria-expanded', String(dom.settings.open)))
  .observe(dom.settings, { attributes: true, attributeFilter: ['open'] });

dom.feedList.addEventListener('pointerdown', () => { touchingFeed = true; });
for (const event of ['pointerup', 'pointercancel']) {
  window.addEventListener(event, () => {
    touchingFeed = false;
    if (pendingFeed) { const next = pendingFeed; pendingFeed = null; renderFeed(next); }
  });
}

for (const button of document.querySelectorAll('.periods button')) {
  button.addEventListener('click', () => selectPeriod(button.dataset.period));
}

render();
initializeFilter();
