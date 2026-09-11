// Durable history for the dashboard.
//
// The store decides what telemetry is allowed to become history. Provider
// filtering, credential stripping, and field whitelisting all happen here,
// before anything reaches SQLite or a browser response.

import { estimateCost } from './pricing.js';
import { createCallerDirectory } from './callers.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { periodStartMs, REPORTING_TIME_ZONE } from './time.js';

export const INCLUDED_PROVIDERS = ['antigravity', 'claude', 'codex', 'opencode', 'mimo'];
export const RECENT_LIMIT = 30;
export const GAP_LIMIT = 50;
export const RETENTION_DAYS = 60;

const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 200;
const TRACKING_SINCE_KEY = 'tracking_since';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp_ms INTEGER NOT NULL,
  provider TEXT NOT NULL,
  account TEXT,
  model TEXT,
  request_id TEXT,
  outcome TEXT NOT NULL,
  duration_ms INTEGER,
  tokens INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  reasoning_tokens INTEGER,
  caller TEXT
);
CREATE INDEX IF NOT EXISTS events_by_timestamp ON events (timestamp_ms DESC, id DESC);
CREATE TABLE IF NOT EXISTS gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gaps_by_start ON gaps (started_at_ms DESC, id DESC);
`;

function toIso(ms) {
  return new Date(ms).toISOString();
}

function asText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function shortText(value, max = MAX_TEXT_LENGTH) {
  const text = asText(value);
  return text ? text.slice(0, max) : null;
}

function asCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Accepts an RFC 3339 string or an epoch-millisecond number.
export function toEpochMs(value) {
  if (Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15) return value;
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) return null;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeProvider(value) {
  const text = asText(value);
  if (!text) return null;
  const provider = text.toLowerCase();
  return INCLUDED_PROVIDERS.includes(provider) ? provider : null;
}

function providerName(value) {
  const text = asText(value);
  if (!text) return null;
  const provider = text.toLowerCase();
  return provider.startsWith('openai-compatible-')
    ? provider.slice('openai-compatible-'.length)
    : provider;
}

// Keeps only whitelisted, non-credential fields. Unknown providers, missing
// timestamps, and malformed payloads return null so the caller can drop them.
function normalizeEvent(raw, callers) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const timestampMs = toEpochMs(raw.timestamp ?? raw.time ?? raw.timestamp_ms);
  if (timestampMs === null) return null;
  const providerSnapshot = asText(raw.auth_provider_snapshot ?? raw.authProviderSnapshot);
  const provider = normalizeProvider(providerName(raw.provider))
    ?? normalizeProvider(providerName(providerSnapshot));
  if (!provider) return null;
  const tokenPayload =
    raw.tokens && typeof raw.tokens === 'object' && !Array.isArray(raw.tokens) ? raw.tokens : {};
  const totalTokens =
    typeof raw.tokens === 'number'
      ? asCount(raw.tokens)
      : asCount(tokenPayload.total_tokens ?? tokenPayload.totalTokens ?? raw.total_tokens);
  const inputTokens = asCount(
    tokenPayload.input_tokens ?? tokenPayload.inputTokens ?? raw.input_tokens ?? raw.inputTokens,
  );
  const outputTokens = asCount(
    tokenPayload.output_tokens ?? tokenPayload.outputTokens ?? raw.output_tokens ?? raw.outputTokens,
  );
  const cachedCandidates = [
    asCount(tokenPayload.cached_tokens ?? tokenPayload.cachedTokens ?? raw.cached_tokens ?? raw.cachedTokens),
    asCount(raw.cache_read_tokens ?? raw.cacheReadTokens),
  ].filter(value => value !== null);
  const failed = raw.failed === true || raw.failed === 'true';
  return {
    timestampMs,
    provider,
    account: shortText(raw.auth_index ?? raw.authIndex ?? raw.account, 120),
    model: shortText(raw.model ?? raw.alias, 120),
    requestId: shortText(raw.request_id ?? raw.requestId, 160),
    outcome: failed ? 'failed' : raw.failed === false || raw.failed === 'false' ? 'success' : 'unknown',
    durationMs: asCount(raw.latency_ms ?? raw.latencyMs),
    // Cached and reasoning counts are reported separately; only the source
    // total is summed so overlapping categories are never added twice.
    tokens: totalTokens,
    inputTokens,
    outputTokens,
    cachedTokens: cachedCandidates.length ? Math.max(...cachedCandidates) : null,
    reasoningTokens: asCount(
      tokenPayload.reasoning_tokens ?? tokenPayload.reasoningTokens ?? raw.reasoning_tokens ?? raw.reasoningTokens,
    ),
    // The raw key is reduced to an opaque caller id here and never kept.
    caller: callers.resolve(raw.api_key ?? raw.apiKey),
  };
}

function emptyTotals() {
  const totals = {};
  for (const provider of INCLUDED_PROVIDERS) {
    totals[provider] = {
      requests: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
    };
  }
  return totals;
}

export function createStore({ path, now = () => Date.now(), apiKeyAliases = [] } = {}) {
  const callers = createCallerDirectory(apiKeyAliases);
  const databasePath = path || ':memory:';
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec(SCHEMA);
  // Remove the retired startup notice from databases created by older builds.
  db.prepare("DELETE FROM gaps WHERE reason = 'service restarted; collection may be incomplete'").run();
  // Databases created before the caller column existed gain it in place.
  if (!db.prepare('PRAGMA table_info(events)').all().some(column => column.name === 'caller')) {
    db.exec('ALTER TABLE events ADD COLUMN caller TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS events_by_caller ON events (caller, timestamp_ms DESC, id DESC)');
  if (databasePath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }

  const readMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const writeMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING');
  const insertEvent = db.prepare(`
    INSERT INTO events (
      timestamp_ms, provider, account, model, request_id, outcome, duration_ms,
      tokens, input_tokens, output_tokens, cached_tokens, reasoning_tokens, caller
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertGap = db.prepare('INSERT INTO gaps (started_at_ms, ended_at_ms, reason) VALUES (?, ?, ?)');
  const readOpenGap = db.prepare('SELECT id FROM gaps WHERE ended_at_ms IS NULL LIMIT 1');
  const writeHeartbeat = db.prepare("INSERT INTO meta (key, value) VALUES ('last_alive_at', ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value");
  const closeGap = db.prepare('UPDATE gaps SET ended_at_ms = ? WHERE ended_at_ms IS NULL');
  const selectTotals = db.prepare(`
    SELECT provider,
      COUNT(*) AS requests,
      COALESCE(SUM(tokens), 0) AS tokens,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens
    FROM events
    WHERE timestamp_ms >= ? AND timestamp_ms <= ? AND (? IS NULL OR caller = ?)
    GROUP BY provider
  `);
  const selectUsage = db.prepare(
    'SELECT provider, model, input_tokens, output_tokens, cached_tokens FROM events '
    + 'WHERE timestamp_ms >= ? AND timestamp_ms <= ? AND (? IS NULL OR caller = ?)'
  );
  const selectRecent = db.prepare(`
    SELECT id, timestamp_ms, provider, account, model, request_id, outcome, duration_ms,
      tokens, input_tokens, output_tokens, cached_tokens, caller
    FROM events
    WHERE (? IS NULL OR caller = ?)
    ORDER BY timestamp_ms DESC, id DESC
    LIMIT ?
  `);
  const selectGaps = db.prepare(`
    SELECT started_at_ms, ended_at_ms, reason
    FROM gaps
    ORDER BY started_at_ms DESC, id DESC
    LIMIT ?
  `);
  const deleteOldEvents = db.prepare('DELETE FROM events WHERE timestamp_ms < ?');
  const deleteOldGaps = db.prepare('DELETE FROM gaps WHERE ended_at_ms IS NOT NULL AND ended_at_ms < ?');

  let trackingSinceMs = toEpochMs(readMeta.get(TRACKING_SINCE_KEY)?.value);
  if (trackingSinceMs === null) {
    trackingSinceMs = now();
    writeMeta.run(TRACKING_SINCE_KEY, toIso(trackingSinceMs));
  }

  let closed = false;
  const heartbeat = () => writeHeartbeat.run(toIso(now()));
  heartbeat();
  let heartbeatFailed = false;
  const heartbeatTimer = setInterval(() => {
    try { heartbeat(); heartbeatFailed = false; } catch { heartbeatFailed = true; }
  }, 5000);
  heartbeatTimer.unref();

  function ingest(raw) {
    const record = normalizeEvent(raw, callers);
    if (!record) return null;
    const info = insertEvent.run(
      record.timestampMs,
      record.provider,
      record.account,
      record.model,
      record.requestId,
      record.outcome,
      record.durationMs,
      record.tokens,
      record.inputTokens,
      record.outputTokens,
      record.cachedTokens,
      record.reasoningTokens,
      record.caller,
    );
    return {
      id: Number(info.lastInsertRowid),
      timestamp: toIso(record.timestampMs),
      provider: record.provider,
      account: record.account,
      model: record.model,
      requestId: record.requestId,
      outcome: record.outcome,
      durationMs: record.durationMs,
      tokens: record.tokens,
    };
  }

  // `caller` is an opaque id from the alias directory, or null for no filter.
  // An id that is not in the directory is treated as no filter, so a stale
  // or guessed id can never widen what the browser sees.
  function snapshot(period = 'today', caller = null) {
    if (heartbeatFailed) throw new Error('Persistent storage heartbeat failed.');
    const filter = typeof caller === 'string' && caller ? caller : null;
    const nowMs = now();
    const startMs = periodStartMs(period, nowMs, REPORTING_TIME_ZONE);
    const totals = emptyTotals();
    for (const row of selectTotals.all(startMs, nowMs, filter, filter)) {
      if (!totals[row.provider]) continue;
      totals[row.provider] = {
        requests: Number(row.requests),
        tokens: Number(row.tokens),
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        cachedTokens: Number(row.cachedTokens),
        reasoningTokens: Number(row.reasoningTokens),
        costUsd: null,
      };
    }
    // Apply context-length pricing to each request before summing.
    for (const row of selectUsage.iterate(startMs, nowMs, filter, filter)) {
      const totalsRow = totals[row.provider];
      if (!totalsRow) continue;
      const usd = estimateCost({ model: row.model, provider: row.provider, inputTokens: row.input_tokens,
        outputTokens: row.output_tokens, cachedTokens: row.cached_tokens });
      if (usd !== null) totalsRow.costUsd = (totalsRow.costUsd ?? 0) + usd;
    }
    const recent = selectRecent.all(filter, filter, RECENT_LIMIT).map((row) => ({
      id: Number(row.id),
      timestamp: toIso(Number(row.timestamp_ms)),
      provider: row.provider,
      account: row.account,
      model: row.model,
      requestId: row.request_id,
      outcome: row.outcome,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      tokens: row.tokens === null ? null : Number(row.tokens),
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      cachedTokens: row.cached_tokens === null ? null : Number(row.cached_tokens),
      costUsd: estimateCost({ model: row.model, provider: row.provider, inputTokens: row.input_tokens, outputTokens: row.output_tokens, cachedTokens: row.cached_tokens }),
      caller: callers.aliasFor(row.caller),
    }));
    const gaps = selectGaps.all(GAP_LIMIT).map((row) => ({
      startedAt: toIso(Number(row.started_at_ms)),
      endedAt: row.ended_at_ms === null ? null : toIso(Number(row.ended_at_ms)),
      reason: row.reason,
    }));
    return { trackingSince: toIso(trackingSinceMs), totals, recent, gaps, callers: callers.list(), caller: filter };
  }

  function recordGap({ startedAt, endedAt = null, reason = 'unknown' } = {}) {
    const startedAtMs = toEpochMs(startedAt);
    if (startedAtMs === null) throw new TypeError('recordGap requires a valid startedAt timestamp');
    const endedAtMs = endedAt === null || endedAt === undefined ? null : toEpochMs(endedAt);
    if (endedAtMs === null && endedAt !== null && endedAt !== undefined) {
      throw new TypeError('recordGap requires endedAt to be a valid timestamp or null');
    }
    const cleanReason = shortText(reason) || 'unknown';
    if (endedAtMs !== null && endedAtMs < startedAtMs) throw new TypeError('Gap end precedes its start.');
    if (endedAtMs !== null || !readOpenGap.get()) insertGap.run(startedAtMs, endedAtMs, cleanReason);
    return {
      startedAt: toIso(startedAtMs),
      endedAt: endedAtMs === null ? null : toIso(endedAtMs),
      reason: cleanReason,
    };
  }

  // Closes the newest open collection gap. The collector uses this on reconnect.
  function closeOpenGap(endedAt = now()) {
    const endedAtMs = toEpochMs(endedAt);
    if (endedAtMs === null) throw new TypeError('closeOpenGap requires a valid timestamp');
    return Number(closeGap.run(endedAtMs).changes);
  }

  function cleanup() {
    const cutoffMs = now() - RETENTION_MS;
    return {
      events: Number(deleteOldEvents.run(cutoffMs).changes),
      gaps: Number(deleteOldGaps.run(cutoffMs).changes),
    };
  }

  function close() {
    if (closed) return;
    clearInterval(heartbeatTimer);
    closed = true;
    try { heartbeat(); } finally { db.close(); }
  }

  cleanup();
  return { ingest, snapshot, recordGap, closeOpenGap, cleanup, close };
}
