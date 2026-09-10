const PROVIDERS = [
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
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

const dom = {
  tracking: document.getElementById('tracking'),
  updated: document.getElementById('updated'),
  gaps: document.getElementById('gaps'),
  collector: document.getElementById('collector'),
  collectorText: document.getElementById('collector-text'),
  banner: document.getElementById('banner'),
  demo: document.getElementById('demo'),
  providers: document.getElementById('providers'),
  feedList: document.getElementById('feed-list'),
  feedEmpty: document.getElementById('feed-empty'),
};

const cards = new Map();

let period = 'today';
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

function percentState(remaining) {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return 'unknown';
  if (remaining <= 0) return 'empty';
  if (remaining < 25) return 'low';
  return 'ok';
}

/* ---------- provider summaries ---------- */

function buildCard({ id, name }) {
  const card = el('article', 'provider');
  card.dataset.provider = id;

  const head = el('header', 'provider-head');
  const accounts = el('span', 'provider-accounts');
  head.append(el('h2', null, name), accounts);

  const totals = el('div', 'totals');
  const stats = {};
  for (const key of ['requests', 'tokens']) {
    const value = el('span', 'stat-value', 'Unknown');
    value.dataset.unknown = 'true';
    const label = el('span', 'stat-label');
    const stat = el('div', 'stat');
    stat.append(value, label);
    totals.append(stat);
    stats[key] = { value, label };
  }

  const windows = el('div', 'windows');
  const exhausted = el('span', 'exhausted');
  const note = el('span', 'note');
  const foot = el('footer', 'provider-foot');
  foot.append(exhausted, note);

  card.append(head, totals, windows, foot);
  const record = { card, accounts, stats, windows, exhausted, note, windowIds: '', windowNodes: new Map() };
  cards.set(id, record);
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
  const reset = el('span', 'reset');
  const message = el('p', 'window-message');
  const foot = el('div', 'window-foot');
  foot.append(coverage, reset);

  window.append(head, bar, foot, message);
  return { window, label, stale, value, bar, fill, coverage, reset, message };
}

function updateWindow(node, entry) {
  const state = percentState(entry.remainingPercent);
  node.window.dataset.state = state;
  node.label.textContent = entry.model && entry.model !== 'all' ? `${entry.label || entry.id} · ${entry.model}` : String(entry.label || entry.id || 'Quota');

  const known = state !== 'unknown';
  node.value.textContent = known ? `${Math.round(entry.remainingPercent)}%` : 'Unknown';
  node.fill.style.setProperty('--pct', known ? String(Math.max(0, Math.min(100, entry.remainingPercent))) : '0');
  node.stale.hidden = entry.stale !== true;

  const observedAt = parseTime(entry.observedAt);
  const age = ageText(observedAt);
  const observed = Number.isFinite(entry.observedAccounts) ? entry.observedAccounts : 0;
  const total = Number.isFinite(entry.totalAccounts) ? entry.totalAccounts : 0;
  const coverage = `${observed} of ${total} accounts`;
  node.coverage.textContent = age ? `${coverage}, read ${age}` : coverage;

  node.reset.textContent = resetText(parseTime(entry.nextResetAt), parseTime(entry.latestResetAt));
  node.message.textContent = entry.message || '';
  node.message.hidden = !entry.message;

  node.window.setAttribute(
    'aria-label',
    known
      ? `${node.label.textContent}: ${Math.round(entry.remainingPercent)} percent remaining, ${coverage}${age ? `, read ${age}` : ''}${entry.stale === true ? ', stale' : ''}`
      : `${node.label.textContent}: remaining capacity Unknown, ${coverage}`,
  );
}

function renderProviders(payload) {
  for (const provider of PROVIDERS) {
    const { id } = provider;
    const card = cards.get(id) ?? buildCard(provider);
    const quota = payload?.quota?.[id] ?? null;
    const totals = payload?.period === period ? payload?.totals?.[id] ?? null : null;

    for (const key of ['requests', 'tokens']) {
      const stat = card.stats[key];
      const raw = totals ? totals[key] : null;
      const known = typeof raw === 'number' && Number.isFinite(raw);
      stat.value.textContent = known
        ? (key === 'tokens' ? compactText(raw) : exactText(raw))
        : 'Unknown';
      stat.value.dataset.unknown = String(!known);
      stat.value.title = known ? exactText(raw) : 'No value recorded';
      stat.label.textContent = `${key}, ${PERIOD_LABELS[period]}`;
    }

    const accounts = quota && Number.isFinite(quota.accounts) ? quota.accounts : 0;
    card.accounts.textContent = `${accounts} ${accounts === 1 ? 'account' : 'accounts'}`;

    const windows = Array.isArray(quota?.windows) ? quota.windows : [];
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

    const exhausted = quota && Number.isFinite(quota.exhausted) ? quota.exhausted : 0;
    card.exhausted.textContent = `${exhausted} of ${accounts} accounts exhausted`;
    card.exhausted.dataset.any = String(exhausted > 0);

    const message = typeof quota?.message === 'string' && quota.message
      ? quota.message
      : windows.length === 0
        ? 'Quota not reported yet'
        : '';
    card.note.textContent = message;
  }
}

/* ---------- live feed ---------- */

function renderFeed(payload) {
  if (touchingFeed) { pendingFeed = payload; return; }
  const recent = Array.isArray(payload?.recent) ? payload.recent : [];
  const signature = recent.map(row => `${row.id}`).join('|');
  if (signature === feedSignature) return;
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

    const time = el('span', 'at', at === null ? 'Unknown' : clockFormat.format(at));
    if (at !== null) time.title = stampFormat.format(at);

    const who = el('span', 'who');
    who.append(el('span', 'prov', PROVIDER_NAMES.get(row.provider) ?? String(row.provider ?? 'Unknown')));
    who.append(el('span', 'model', String(row.model ?? 'Unknown model')));
    const duration = durationText(row.durationMs);
    if (duration) who.append(el('span', 'dur', duration));

    const tokens = compactText(row.tokens);
    const tokenCell = el('span', 'num', tokens);
    tokenCell.dataset.unknown = String(tokens === 'n/a');
    tokenCell.title = typeof row.tokens === 'number' ? exactText(row.tokens) : 'No token count reported';

    const key = OUTCOME_LABELS[row.outcome] ? (row.outcome === 'failed' || row.outcome === 'error' ? 'failed' : 'ok') : 'unknown';
    const result = el('span', 'result');
    result.dataset.result = key;
    result.append(el('span', 'pip'), el('span', null, OUTCOME_LABELS[row.outcome] ?? String(row.outcome ?? 'Unknown')));

    item.append(time, who, tokenCell, result);
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
    : `Tracking since ${stampFormat.format(tracking)} · Central Time`;

  if (lastError) {
    dom.updated.textContent = lastGoodAt === null
      ? 'No reading yet'
      : `Last reading ${clockFormat.format(lastGoodAt)}`;
  } else {
    const generated = parseTime(view?.generatedAt);
    dom.updated.textContent = generated === null ? 'Waiting for the first reading' : `Updated ${clockFormat.format(generated)}`;
  }

  const gaps = Array.isArray(view?.gaps) ? view.gaps.slice() : [];
  gaps.sort((a, b) => (parseTime(b?.startedAt) ?? 0) - (parseTime(a?.startedAt) ?? 0));
  const gap = gaps[0];
  const gapStart = parseTime(gap?.startedAt);
  if (gap && gapStart !== null) {
    const end = parseTime(gap?.endedAt);
    const when = end === null ? `since ${shortTime(gapStart)}` : `${shortTime(gapStart)}-${shortTime(end)}`;
    dom.gaps.textContent = `Collection gap ${when}${gap.reason ? ` (${gap.reason})` : ''}`;
    dom.gaps.hidden = false;
  } else {
    dom.gaps.hidden = true;
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

function renderNotices() {
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
  renderNotices();
}

/* ---------- polling ---------- */

function schedule(delay = POLL_MS) {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(load, delay);
}

async function load() {
  if (inFlight !== null) return;
  timer = null;
  const mine = token + 1;
  token = mine;
  const requested = period;
  const controller = new AbortController();
  inFlight = controller;

  let payload = null;
  let failure = null;
  try {
    const response = await fetch(`/api/dashboard?period=${encodeURIComponent(requested)}`, {
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

function selectPeriod(next) {
  if (!Object.hasOwn(PERIOD_LABELS, next) || next === period) return;
  period = next;
  for (const button of document.querySelectorAll('.periods button')) {
    button.setAttribute('aria-pressed', String(button.dataset.period === period));
  }
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
load();
