// Provider quota normalization and aggregation.
//
// Account inventory comes from the proxy management API. Each account's quota
// comes from an authenticated upstream call through POST /v0/management/api-call.
// Unrecognized payload shapes stay Unknown with an actionable message instead of
// being guessed into a percentage.

import { managementBase } from './config.js';
const INCLUDED_PROVIDERS = ['antigravity', 'claude', 'codex'];

const REQUEST_TIMEOUT_MS = 10000;
// Spacing between upstream account calls, so a provider is not asked for every
// account's quota in one burst.
const DEFAULT_SPACING_MS = 500;
const MAX_MESSAGE_LENGTH = 200;
const EXHAUSTED_AT_OR_BELOW = 0;

// Upstream quota endpoints, as used by the reference implementation.
const QUOTA_ENDPOINTS = {
  codex: {
    method: 'GET',
    url: 'https://chatgpt.com/backend-api/wham/usage',
    headers: () => ({
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'User-Agent': 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)',
    }),
  },
  claude: {
    method: 'GET',
    url: 'https://api.anthropic.com/api/oauth/usage',
    headers: () => ({
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    }),
  },
  antigravity: {
    method: 'POST',
    url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    headers: () => ({
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)',
    }),
  },
};

// Windows every provider is expected to report, so the display has stable
// Unknown bars before the first successful reading.
const EXPECTED_WINDOWS = {
  antigravity: [
    { id: 'gemini-five-hour', label: 'Gemini 5-hour', model: 'gemini' },
    { id: 'gemini-weekly', label: 'Gemini weekly', model: 'gemini' },
  ],
  claude: [
    { id: 'five-hour', label: '5-hour', model: 'all' },
    { id: 'seven-day', label: 'Weekly', model: 'all' },
  ],
  codex: [
    { id: 'primary', label: 'Primary', model: 'all' },
    { id: 'secondary', label: 'Secondary', model: 'all' },
  ],
};

const CLAUDE_WINDOW_KEYS = [
  { key: 'five_hour', id: 'five-hour', label: '5-hour', model: 'all' },
  { key: 'seven_day', id: 'seven-day', label: 'Weekly', model: 'all' },
  { key: 'seven_day_oauth_apps', id: 'seven-day-oauth-apps', label: 'Weekly (OAuth apps)', model: 'all' },
  { key: 'seven_day_opus', id: 'seven-day-opus', label: 'Weekly (Opus)', model: 'opus' },
  { key: 'seven_day_sonnet', id: 'seven-day-sonnet', label: 'Weekly (Sonnet)', model: 'sonnet' },
  { key: 'seven_day_cowork', id: 'seven-day-cowork', label: 'Weekly (Cowork)', model: 'all' },
];

const ANTIGRAVITY_FIVE_HOUR_SECONDS = 5 * 60 * 60;
const ANTIGRAVITY_WEEKLY_SECONDS = 7 * 24 * 60 * 60;

class QuotaError extends Error {
  constructor(message, fatal = false) {
    super(message);
    this.name = 'QuotaError';
    this.fatal = fatal;
  }
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPercent(value) {
  return value >= 0 && value <= 100 ? value : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function clean(message) {
  return String(message ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function toIso(ms) {
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}

// Reads a reset instant from whichever spelling the provider uses. Values that
// only describe a delay are converted against the observation time.
function resetFrom(record, nowMs) {
  const absolute = record.resets_at ?? record.resetTime ?? record.reset_time;
  if (typeof absolute === 'string' && Number.isFinite(Date.parse(absolute))) return Date.parse(absolute);
  const epoch = asNumber(record.reset_at);
  if (epoch !== null && toIso(epoch * 1000)) return epoch * 1000;
  const after = asNumber(record.reset_after_seconds);
  if (after !== null && after >= 0 && Number.isFinite(nowMs)) return nowMs + after * 1000;
  return null;
}

function windowLabelFromSeconds(seconds, fallback) {
  if (!Number.isFinite(seconds)) return fallback;
  if (seconds === ANTIGRAVITY_FIVE_HOUR_SECONDS) return '5-hour';
  if (seconds === 86400) return 'Daily';
  if (seconds === ANTIGRAVITY_WEEKLY_SECONDS) return 'Weekly';
  return `${fallback} (${seconds}s)`;
}

function codexWindow(id, raw, nowMs) {
  const usedPercent = asNumber(raw.used_percent ?? raw.usedPercent ?? raw.utilization);
  if (usedPercent === null || clampPercent(usedPercent) === null) return null;
  const seconds = asNumber(raw.limit_window_seconds ?? raw.limitWindowSeconds ?? raw.window_seconds);
  const fallback = id === 'primary' ? 'Primary' : 'Secondary';
  return {
    id: seconds === null ? `${id}-unspecified` : seconds !== (id === 'primary' ? 18000 : 604800) ? `${id}-${seconds}s` : id,
    label: windowLabelFromSeconds(seconds, fallback),
    model: 'all',
    remainingPercent: round2(clampPercent(100 - usedPercent)),
    resetAtMs: resetFrom(raw, nowMs),
  };
}

function parseCodexUsage(payload, nowMs) {
  const rateLimit = asRecord(asRecord(payload)?.rate_limit ?? asRecord(payload)?.rateLimit);
  const windows = [];
  const scopes = [{ model: 'all', rate: rateLimit }, { model: 'code review', rate: payload?.code_review_rate_limit }];
  for (const extra of Array.isArray(payload?.additional_rate_limits) ? payload.additional_rate_limits : []) {
    const model = asText(extra.limit_name ?? extra.metered_feature);
    if (model && !/spark/i.test(model)) scopes.push({ model, rate: extra.rate_limit });
  }
  for (const { model, rate } of scopes) {
    if (!asRecord(rate)) continue;
    for (const id of ['primary', 'secondary']) {
      const raw = asRecord(rate[`${id}_window`]);
      if (!raw) continue;
      const window = codexWindow(id, raw, nowMs);
      if (window) windows.push({ ...window, id: model === 'all' ? window.id : `${model}:${window.id}`, model });
    }
  }
  return {
    windows,
    note: windows.length ? '' : 'Codex usage response had no recognizable window values.',
  };
}

function parseClaudeUsage(payload) {
  const root = asRecord(payload);
  if (!root) return { windows: [], note: 'Claude usage response was not recognized.' };
  const windows = [];
  for (const spec of CLAUDE_WINDOW_KEYS) {
    const raw = asRecord(root[spec.key]);
    if (!raw) continue;
    const usedPercent = asNumber(raw.utilization ?? raw.used_percent ?? raw.usedPercent);
    if (usedPercent === null || clampPercent(usedPercent) === null) continue;
    windows.push({
      id: spec.id,
      label: spec.label,
      model: spec.model,
      remainingPercent: round2(clampPercent(100 - usedPercent)),
      resetAtMs: resetFrom(raw),
    });
  }
  return {
    windows,
    note: windows.length ? '' : 'Claude usage response had no recognizable window values.',
  };
}

// Explicit public CPAMP summary and available-model shapes. Never infer a
// window from time until reset, or merge different Gemini models together.
function parseAntigravityUsage(payload, nowMs) {
  const windows = [];
  const labels = { '5h': '5-hour', 'five-hour': '5-hour', five_hour: '5-hour', weekly: 'Weekly', week: 'Weekly' };
  for (const group of Array.isArray(payload?.groups) ? payload.groups : []) {
    const model = asText(group.displayName ?? group.display_name);
    if (!model || !/gemini/i.test(model) || /claude|gpt/i.test(model)) continue;
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      const fraction = asNumber(bucket.remainingFraction ?? bucket.remaining_fraction);
      if (fraction === null || fraction < 0 || fraction > 1) continue;
      const window = asText(bucket.window)?.toLowerCase();
      const label = labels[window] ?? (window ? clean(window) : 'Provider window');
      const bucketId = asText(bucket.bucketId ?? bucket.bucket_id);
      if (!window && !bucketId) continue;
      const scope = model.toLowerCase();
      const standard = scope === 'gemini' && ['5-hour', 'Weekly'].includes(label);
      windows.push({
        id: standard ? (label === '5-hour' ? 'gemini-five-hour' : 'gemini-weekly') : `${scope}:${label}:${bucketId || window}`,
        label, model: clean(model), remainingPercent: round2(fraction * 100), resetAtMs: resetFrom(bucket, nowMs),
      });
    }
  }
  if (!windows.length && asRecord(payload?.models)) {
    for (const [model, entry] of Object.entries(payload.models)) {
      if (!/gemini/i.test(model) || /claude|gpt/i.test(model)) continue;
      const info = asRecord(entry?.quotaInfo ?? entry?.quota_info);
      if (!info) continue;
      const fraction = asNumber(info.remainingFraction ?? info.remaining_fraction ?? info.remaining);
      if (fraction === null || fraction < 0 || fraction > 1) continue;
      windows.push({ id: `model:${model}`, label: 'Provider window', model: clean(model),
        remainingPercent: round2(fraction * 100), resetAtMs: resetFrom(info, nowMs) });
    }
  }
  const hasFiveHour = windows.some(w => w.label === '5-hour');
  const hasWeekly = windows.some(w => w.label === 'Weekly');
  const note = hasFiveHour && hasWeekly ? '' : 'Gemini five-hour/weekly allowances are not both identified by this response. Provider windows remain separate.';
  return { windows, note };
}

const PARSERS = {
  codex: parseCodexUsage,
  claude: parseClaudeUsage,
  antigravity: parseAntigravityUsage,
};

function managementUrl(base, pathname) {
  return `${managementBase(base)}/${pathname}`;
}

function retryAfterMs(headers, nowMs) {
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  return parseRetryAfter(raw, nowMs);
}

function parseRetryAfter(raw, nowMs) {
  const text = asText(raw);
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(text);
  return Number.isFinite(date) && date > nowMs ? date - nowMs : null;
}

function headerRetryAfter(header, nowMs) {
  const record = asRecord(header);
  if (!record) return null;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== 'retry-after') continue;
    const raw = Array.isArray(value) ? value[0] : value;
    return parseRetryAfter(raw, nowMs);
  }
  return null;
}

function describeAccount(file) {
  const provider = INCLUDED_PROVIDERS.includes(String(file?.provider ?? '').toLowerCase())
    ? String(file.provider).toLowerCase()
    : null;
  if (!provider || file.disabled === true) return null;
  const authIndex = asText(file.auth_index ?? file.authIndex);
  const name = asText(file.name);
  const key = authIndex;
  if (!key) return null;
  const attributes = asRecord(file.attributes);
  const metadata = asRecord(file.metadata);
  return {
    provider,
    key,
    authIndex,
    name,
    chatgptAccountId: asText(
      file.account_id ?? file.accountId ?? file.chatgpt_account_id ?? metadata?.account_id,
    ),
    projectId: asText(
      file.project_id ??
        file.projectId ??
        attributes?.project_id ??
        attributes?.gemini_virtual_project ??
        metadata?.project_id,
    ),
  };
}

function createProviderState(provider) {
  const windows = new Map();
  for (const spec of EXPECTED_WINDOWS[provider]) {
    windows.set(spec.id, { ...spec, observations: new Map() });
  }
  return { provider, accounts: [], windows, notes: new Map(), message: '' };
}

function markProviderStale(state, message) {
  state.message = clean(message);
  for (const window of state.windows.values()) {
    for (const observation of window.observations.values()) observation.stale = true;
  }
}

function weightFor(provider, account, codexWeights) {
  if (provider !== 'codex') return 1;
  return codexWeights.get(account.authIndex) ?? null;
}

function weightedAverage(entries) {
  let weighted = 0;
  let total = 0;
  for (const entry of entries) {
    weighted += entry.weight * entry.remainingPercent;
    total += entry.weight;
  }
  return total > 0 ? round2(weighted / total) : null;
}

export function createQuotaService({
  baseUrl,
  managementKey,
  codexWeights = {},
  intervalMs = 30 * 60 * 1000,
  spacingMs = DEFAULT_SPACING_MS,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const configured = Boolean(baseUrl) && Boolean(managementKey);
  const states = new Map(INCLUDED_PROVIDERS.map((provider) => [provider, createProviderState(provider)]));
  const accountsByKey = new Map();
  const weights = new Map();
  for (const [key, value] of Object.entries(asRecord(codexWeights) ?? {})) {
    const weight = asNumber(value);
    if (weight === 5 || weight === 20) weights.set(key.trim(), weight);
  }

  let timer = null;
  let started = false;
  let stopped = false;
  let inFlight = null;
  // The management API throttling us pauses everything; an upstream provider
  // throttling one of its accounts pauses only that provider.
  let managementPausedUntilMs = 0;
  const providerPausedUntilMs = new Map();
  let lastRequestAtMs = 0;
  let fatalMessage = '';
  let activeAbort = null;
  const rejectedAccounts = new Set();

  function pauseManagement(untilMs) {
    managementPausedUntilMs = Math.max(managementPausedUntilMs, untilMs);
  }

  function pauseProvider(provider, untilMs) {
    providerPausedUntilMs.set(provider, Math.max(providerPausedUntilMs.get(provider) ?? 0, untilMs));
  }

  function pausedUntil(provider) {
    return Math.max(managementPausedUntilMs, providerPausedUntilMs.get(provider) ?? 0);
  }

  // Keeps upstream account calls from arriving as one burst.
  async function spaceRequests() {
    const waitMs = spacingMs > 0 && lastRequestAtMs > 0 ? lastRequestAtMs + spacingMs - now() : 0;
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAtMs = now();
  }

  function snapshot() {
    const result = {};
    for (const provider of INCLUDED_PROVIDERS) {
      const state = states.get(provider);
      const totalAccounts = state.accounts.length;
      const observedKeys = new Set();
      const exhaustedKeys = new Set();
      const windows = [];
      const reportedWindows = [...state.windows.values()].filter(window => window.observations.size > 0);
      for (const window of reportedWindows.length ? reportedWindows : state.windows.values()) {
        const observations = [...window.observations.entries()].filter(([key]) => {
          const account = accountsByKey.get(key);
          return account && weightFor(provider, account, weights) !== null;
        });
        const included = [];
        let unmapped = state.accounts.filter(account => weightFor(provider, account, weights) === null).length;
        let stale = false;
        for (const [key, observation] of observations) {
          if (observation.stale || now() - observation.observedAtMs > intervalMs * 2) stale = true;
          if (observation.remainingPercent === null) continue;
          const account = accountsByKey.get(key);
          const weight = account ? weightFor(provider, account, weights) : null;
          if (weight === null) {
            unmapped += 1;
            continue;
          }
          included.push({ weight, remainingPercent: observation.remainingPercent });
          observedKeys.add(key);
          if (observation.remainingPercent <= EXHAUSTED_AT_OR_BELOW) exhaustedKeys.add(key);
        }
        const resets = observations
          .map(([, observation]) => observation.resetAtMs)
          .filter((value) => Number.isFinite(value));
        const observedTimes = observations
          .map(([, observation]) => observation.observedAtMs)
          .filter((value) => Number.isFinite(value));
        let message = '';
        const note = [...state.notes.values()][0];
        if (unmapped > 0) {
          message = `${unmapped} account(s) excluded: no configured weight.`;
        } else if (included.length === 0) {
          message = note || (observations.length ? 'Quota values are not available.' : 'Unknown until the first reading.');
        } else if (note) {
          message = note;
        }
        windows.push({
          id: window.id,
          label: window.label,
          model: window.model,
          remainingPercent: weightedAverage(included),
          observedAccounts: included.length,
          totalAccounts,
          stale,
          observedAt: toIso(observedTimes.length ? Math.min(...observedTimes) : null),
          nextResetAt: toIso(resets.length ? Math.min(...resets) : null),
          latestResetAt: toIso(resets.length ? Math.max(...resets) : null),
          message,
        });
      }
      result[provider] = {
        accounts: totalAccounts,
        exhausted: exhaustedKeys.size,
        observedAccounts: observedKeys.size,
        windows,
        message: state.message || (provider === 'codex' && state.accounts.some(a => weightFor(provider, a, weights) === null)
          ? 'Set CODEX_ACCOUNT_WEIGHTS by auth_index to 5 or 20; unmapped accounts are excluded.' : [...state.notes.values()][0] || ''),
      };
    }
    return result;
  }

  async function requestJson(url, init, label) {
    let response;
    try {
      activeAbort = new AbortController();
      response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.any([activeAbort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
    } catch {
      throw new QuotaError(`${label} failed; check backend connectivity.`);
    }
    const retryMs = retryAfterMs(response.headers, now());
    if (retryMs !== null) pauseManagement(now() + retryMs);
    if (response.status === 401 || response.status === 403) {
      throw new QuotaError(`Management authentication failed (HTTP ${response.status}).`, true);
    }
    if (response.status === 429) {
      pauseManagement(now() + (retryMs ?? 60000));
      throw new QuotaError(`${label} was throttled (HTTP 429).`);
    }
    if (!response.ok) throw new QuotaError(`${label} failed (HTTP ${response.status}).`);
    try {
      return await response.json();
    } catch {
      throw new QuotaError(`${label} returned a response that was not JSON.`);
    }
  }

  async function discoverAccounts() {
    const body = await requestJson(
      managementUrl(baseUrl, 'auth-files'),
      { method: 'GET', headers: { Authorization: `Bearer ${managementKey}` } },
      'Account discovery',
    );
    const files = Array.isArray(body?.files) ? body.files : null;
    if (!files) throw new QuotaError('Account discovery response was not recognized.');
    const grouped = new Map(INCLUDED_PROVIDERS.map((provider) => [provider, []]));
    for (const file of files) {
      const account = describeAccount(file);
      if (account) grouped.get(account.provider).push(account);
    }
    return grouped;
  }

  async function fetchAccountQuota(account) {
    if (account.provider === 'antigravity' && !account.projectId) {
      throw new QuotaError('Antigravity project_id metadata is missing; quota is unavailable.');
    }
    const endpoint = QUOTA_ENDPOINTS[account.provider];
    const headers = endpoint.headers();
    if (account.provider === 'codex' && account.chatgptAccountId) {
      headers['chatgpt-account-id'] = account.chatgptAccountId;
    }
    const request = {
      auth_index: account.authIndex,
      method: endpoint.method,
      url: endpoint.url,
      header: headers,
    };
    if (account.provider === 'antigravity') {
      request.data = JSON.stringify(account.projectId ? { project: account.projectId } : {});
    }
    const body = await requestJson(
      managementUrl(baseUrl, 'api-call'),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${managementKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
      `${account.provider} quota request`,
    );
    const statusCode = Number(body?.status_code ?? body?.statusCode);
    const retryMs = headerRetryAfter(body?.header, now());
    if (retryMs !== null) pauseProvider(account.provider, now() + retryMs);
    if (statusCode === 429) pauseProvider(account.provider, now() + (retryMs ?? 60000));
    if (statusCode === 401 || statusCode === 403) rejectedAccounts.add(account.key);
    if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
      throw new QuotaError(`${account.provider} quota request failed (HTTP ${Number.isFinite(statusCode) ? statusCode : 'unknown'}).`);
    }
    let payload = body?.body ?? body?.bodyText;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        throw new QuotaError(`${account.provider} quota response was not JSON.`);
      }
    }
    const parsed = PARSERS[account.provider](payload, now());
    return parsed;
  }

  function applyObservations(state, account, parsed) {
    // Omitted/unrecognized windows must not keep an old observation marked fresh.
    markAccountStale(state, account, 'Quota window was not reported in the latest response.');
    state.notes.delete(account.key);
    if (parsed.note) state.notes.set(account.key, parsed.note);
    const observedAtMs = now();
    for (const window of parsed.windows) {
      let entry = state.windows.get(window.id);
      if (!entry) {
        entry = { id: window.id, label: window.label, model: window.model, observations: new Map() };
        state.windows.set(window.id, entry);
      }
      entry.label = window.label;
      entry.model = window.model;
      entry.observations.set(account.key, {
        remainingPercent: window.remainingPercent,
        resetAtMs: window.resetAtMs,
        observedAtMs,
        stale: false,
      });
    }
  }

  function markAccountStale(state, account, reason) {
    state.notes.set(account.key, reason);
    for (const window of state.windows.values()) {
      const existing = window.observations.get(account.key);
      if (existing) existing.stale = true;
    }
  }

  async function runCycle() {
    let grouped;
    try {
      grouped = await discoverAccounts();
    } catch (error) {
      const message = clean(error instanceof Error ? error.message : error);
      if (error?.fatal) {
        fatalMessage = message;
        stop();
      }
      for (const state of states.values()) markProviderStale(state, message);
      return snapshot();
    }

    fatalMessage = '';
    const discoveredKeys = new Set();
    for (const provider of INCLUDED_PROVIDERS) {
      for (const account of grouped.get(provider)) discoveredKeys.add(account.key);
    }
    for (const key of [...accountsByKey.keys()]) {
      if (!discoveredKeys.has(key)) accountsByKey.delete(key);
    }
    for (const provider of INCLUDED_PROVIDERS) {
      for (const account of grouped.get(provider)) accountsByKey.set(account.key, account);
    }

    for (const provider of INCLUDED_PROVIDERS) {
      const state = states.get(provider);
      const accounts = grouped.get(provider);
      state.accounts = accounts;
      state.message = accounts.length ? '' : 'No accounts found for this provider.';
      const activeKeys = new Set(accounts.map((account) => account.key));
      for (const window of state.windows.values()) {
        for (const key of [...window.observations.keys()]) {
          if (!activeKeys.has(key)) window.observations.delete(key);
        }
      }
      for (const key of [...state.notes.keys()]) {
        if (!activeKeys.has(key)) state.notes.delete(key);
      }

      let failures = 0;
      for (const account of accounts) {
        if (stopped) return snapshot();
        if (now() < pausedUntil(provider) || rejectedAccounts.has(account.key)) {
          failures += 1;
          markAccountStale(state, account, rejectedAccounts.has(account.key)
            ? 'Provider rejected account authentication; refresh paused until service restart.'
            : 'Quota refresh paused to respect upstream throttling.');
          continue;
        }
        await spaceRequests();
        if (stopped) return snapshot();
        try {
          applyObservations(state, account, await fetchAccountQuota(account));
        } catch (error) {
          if (error?.fatal) {
            fatalMessage = clean(error.message);
            markProviderStale(state, fatalMessage);
            stop();
            return snapshot();
          }
          failures += 1;
          markAccountStale(state, account, clean(error instanceof Error ? error.message : error));
        }
      }
      if (failures > 0) {
        state.message = `${failures} of ${accounts.length} accounts failed to refresh.`;
      }
    }
    return snapshot();
  }

  function refresh() {
    if (stopped) return Promise.resolve(snapshot());
    if (inFlight) return inFlight;
    if (now() < managementPausedUntilMs) return Promise.resolve(snapshot());
    if (!configured) {
      for (const state of states.values()) state.message = 'Management API is not configured.';
      return Promise.resolve(snapshot());
    }
    inFlight = runCycle()
      .catch((error) => {
        const message = clean(error instanceof Error ? error.message : error);
        for (const state of states.values()) markProviderStale(state, message);
        return snapshot();
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function start() {
    if (started) return;
    started = true;
    if (!configured) {
      for (const state of states.values()) state.message = 'Management API is not configured.';
      return;
    }
    refresh();
    timer = setInterval(() => {
      refresh();
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    activeAbort?.abort();
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (fatalMessage) {
      for (const state of states.values()) markProviderStale(state, fatalMessage);
    }
  }

  return { start, stop, refresh, snapshot };
}
