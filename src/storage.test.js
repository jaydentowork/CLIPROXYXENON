import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

import { createStore } from './storage.js';
import { callerId } from './callers.js';
import { setPricingCatalog } from './pricing.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function withStore(now = () => Date.now()) {
  const dir = mkdtempSync(join(tmpdir(), 'xeneon-store-'));
  const path = join(dir, 'dashboard.sqlite');
  const store = createStore({ path, now });
  return {
    dir,
    path,
    store,
    dispose() {
      store.close();
      assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
      assert.ok(dir.includes('xeneon-store-'));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function usageEvent(overrides = {}) {
  return {
    timestamp: '2026-09-10T18:00:00Z',
    latency_ms: 1500,
    source: 'user@example.com',
    auth_index: 'auth-1',
    tokens: {
      input_tokens: 10,
      output_tokens: 20,
      reasoning_tokens: 0,
      cached_tokens: 0,
      total_tokens: 30,
    },
    failed: false,
    provider: 'codex',
    model: 'gpt-5.4',
    alias: 'client-gpt',
    endpoint: 'POST /v1/chat/completions',
    auth_type: 'apikey',
    api_key: 'sk-secret-value',
    request_id: 'req-1',
    response_headers: { 'X-Upstream-Request-Id': ['upstream-1'] },
    ...overrides,
  };
}

test('only included providers become history', (t) => {
  const fixture = withStore(() => Date.parse('2026-09-10T18:30:00Z'));
  t.after(() => fixture.dispose());
  const { store } = fixture;

  assert.equal(store.ingest(usageEvent({ provider: 'xai' })), null);
  assert.equal(store.ingest(usageEvent({ provider: 'openai' })), null);
  assert.equal(store.ingest(usageEvent({ provider: 'gemini' })), null);

  // Claude models routed through Antigravity stay in Antigravity activity.
  const routed = store.ingest(
    usageEvent({ provider: 'Antigravity', model: 'claude-sonnet-4-6', request_id: 'req-2' }),
  );
  assert.equal(routed.provider, 'antigravity');
  assert.equal(routed.model, 'claude-sonnet-4-6');

  const snapshot = store.snapshot('today');
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.totals.antigravity.requests, 1);
  assert.equal(snapshot.totals.codex.requests, 0);
  assert.equal(snapshot.totals.xai, undefined);
});

test('OpenAI-compatible provider fields infer the provider and flat token fields', (t) => {
  const timestampMs = 1789084285961;
  const fixture = withStore(() => timestampMs + 10);
  t.after(() => fixture.dispose());
  const { store } = fixture;

  const stored = store.ingest({
    request_id: '688bbbb4',
    timestamp_ms: timestampMs,
    model: 'deepseek-flash',
    auth_index: 'add7e1f19747ef6e',
    auth_provider_snapshot: 'openai-compatible-opencode',
    executor_type: 'OpenAICompatExecutor',
    input_tokens: 106271,
    output_tokens: 373,
    cached_tokens: 0,
    cache_read_tokens: 106112,
    reasoning_tokens: 187,
    total_tokens: 106644,
    latency_ms: 3180,
    failed: false,
  });

  assert.equal(stored.provider, 'opencode');
  assert.equal(stored.tokens, 106644);
  const prefixed = store.ingest({
    request_id: 'live-shape',
    timestamp_ms: timestampMs + 1,
    provider: 'openai-compatible-opencode',
    model: 'deepseek-flash',
    total_tokens: 42,
    failed: false,
  });
  assert.equal(prefixed.provider, 'opencode');
  const snapshot = store.snapshot('today');
  assert.equal(snapshot.recent[1].inputTokens, 106271);
  assert.equal(snapshot.recent[1].outputTokens, 373);
  assert.equal(snapshot.recent[1].cachedTokens, 106112);
  assert.equal(snapshot.totals.opencode.inputTokens, 106271);
  assert.equal(snapshot.totals.opencode.outputTokens, 373);
  assert.equal(snapshot.totals.opencode.cachedTokens, 106112);
  assert.equal(snapshot.totals.opencode.requests, 2);
  assert.equal(snapshot.totals.opencode.tokens, 106686);
  assert.equal(snapshot.totals.opencode.reasoningTokens, 187);
});

test('credentials and unused payload fields never reach storage', (t) => {
  const fixture = withStore();
  t.after(() => fixture.dispose());
  const { store, path } = fixture;

  const stored = store.ingest(usageEvent());
  assert.deepEqual(Object.keys(stored).sort(), [
    'account',
    'durationMs',
    'id',
    'model',
    'outcome',
    'provider',
    'requestId',
    'timestamp',
    'tokens',
  ]);
  store.close();

  const raw = ['', '-wal', '-shm']
    .map((suffix) => (existsSync(path + suffix) ? readFileSync(path + suffix, 'latin1') : ''))
    .join('\n');
  assert.equal(raw.includes('sk-secret-value'), false);
  assert.equal(raw.includes('upstream-1'), false);
  assert.equal(raw.includes('client-gpt'), false);
  assert.equal(raw.includes('user@example.com'), false);
});

test('malformed telemetry is dropped without throwing', (t) => {
  const fixture = withStore();
  t.after(() => fixture.dispose());
  const { store } = fixture;

  assert.equal(store.ingest(null), null);
  assert.equal(store.ingest('not an object'), null);
  assert.equal(store.ingest([]), null);
  assert.equal(store.ingest({ provider: 'codex' }), null);
  assert.equal(store.ingest(usageEvent({ timestamp: 'not-a-time' })), null);
  assert.equal(store.ingest(usageEvent({ provider: '' })), null);
  assert.equal(store.snapshot('today').recent.length, 0);
});

test('epoch-millisecond timestamps and string booleans are accepted', (t) => {
  const fixture = withStore();
  t.after(() => fixture.dispose());
  const { store } = fixture;

  const stored = store.ingest(
    usageEvent({ timestamp: Date.parse('2026-09-10T18:00:00Z'), failed: 'true', tokens: 42 }),
  );
  assert.equal(stored.outcome, 'failed');
  assert.equal(stored.tokens, 42);
  assert.equal(stored.timestamp, '2026-09-10T18:00:00.000Z');
});

test('period totals use Central time boundaries', (t) => {
  const clock = Date.parse('2026-09-10T18:30:00Z');
  const fixture = withStore(() => clock);
  t.after(() => fixture.dispose());
  const { store } = fixture;

  store.ingest(usageEvent({ timestamp: '2026-09-01T12:00:00Z', tokens: 100 }));
  store.ingest(usageEvent({ timestamp: '2026-09-07T05:00:00Z', tokens: 200 }));
  store.ingest(usageEvent({ timestamp: '2026-09-10T04:00:00Z', tokens: 1000, provider: 'claude' }));
  store.ingest(usageEvent({ timestamp: '2026-09-10T05:00:00Z', tokens: 300 }));
  store.ingest(usageEvent({ timestamp: '2026-09-10T12:00:00Z', provider: 'claude' }));

  assert.deepEqual(store.snapshot('today').totals.codex, {
    requests: 1,
    tokens: 300,
    models: [{ model: 'gpt-5.4', requests: 1, tokens: 300, costUsd: null, pricedRequests: 0 }],
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
  });
  assert.deepEqual(store.snapshot('today').totals.claude, {
    requests: 1,
    tokens: 30,
    models: [{ model: 'gpt-5.4', requests: 1, tokens: 30, costUsd: (10 * 2.5 + 20 * 15) / 1e6, pricedRequests: 1 }],
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: 0,
    reasoningTokens: 0,
    costUsd: (10 * 2.5 + 20 * 15) / 1e6,
  });
  assert.equal(store.snapshot('week').totals.codex.tokens, 500);
  assert.equal(store.snapshot('week').totals.claude.requests, 2);
  assert.equal(store.snapshot('month').totals.codex.tokens, 600);
  assert.equal(store.snapshot('month').totals.antigravity.requests, 0);
});

test('the recent feed is newest first, bounded, and period independent', (t) => {
  const clock = Date.parse('2026-09-10T18:30:00Z');
  const fixture = withStore(() => clock);
  t.after(() => fixture.dispose());
  const { store } = fixture;

  const base = clock - 60 * DAY_MS;
  for (let index = 0; index < 35; index += 1) {
    store.ingest(usageEvent({ timestamp: base + index * 1000, request_id: `req-${index}` }));
  }

  const today = store.snapshot('today');
  const month = store.snapshot('month');
  assert.equal(today.recent.length, 30);
  assert.equal(today.recent[0].requestId, 'req-34');
  assert.equal(today.recent.at(-1).requestId, 'req-5');
  assert.deepEqual(today.recent, month.recent);
  assert.equal(today.totals.codex.requests, 0);
});

test('collection gaps are recorded with ISO timestamps', (t) => {
  const fixture = withStore();
  t.after(() => fixture.dispose());
  const { store } = fixture;

  store.recordGap({ startedAt: '2026-09-10T10:00:00Z', endedAt: null, reason: 'disconnected' });
  assert.deepEqual(store.snapshot('today').gaps[0], {
    startedAt: '2026-09-10T10:00:00.000Z',
    endedAt: null,
    reason: 'disconnected',
  });

  assert.equal(store.closeOpenGap('2026-09-10T10:05:00Z'), 1);
  assert.equal(store.snapshot('today').gaps[0].endedAt, '2026-09-10T10:05:00.000Z');
  assert.throws(() => store.recordGap({ startedAt: 'nope' }), TypeError);
});

test('history and tracking start survive a restart', (t) => {
  const clock = Date.parse('2026-09-10T18:30:00Z');
  const fixture = withStore(() => clock);
  t.after(() => fixture.dispose());

  fixture.store.ingest(usageEvent());
  const trackingSince = fixture.store.snapshot('today').trackingSince;
  fixture.store.close();
  const legacy = new DatabaseSync(fixture.path);
  legacy.prepare('INSERT INTO gaps (started_at_ms, ended_at_ms, reason) VALUES (?, ?, ?)').run(
    clock - 1000, clock, 'service restarted; collection may be incomplete');
  legacy.close();

  const reopened = createStore({ path: fixture.path, now: () => clock + 1000 });
  const snapshot = reopened.snapshot('today');
  assert.equal(snapshot.trackingSince, trackingSince);
  assert.equal(snapshot.recent.length, 1);
  assert.deepEqual(snapshot.gaps, []);
  reopened.close();
});

test('cleanup drops records older than 60 days', (t) => {
  const clock = Date.parse('2026-09-10T18:30:00Z');
  const fixture = withStore(() => clock);
  t.after(() => fixture.dispose());

  fixture.store.ingest(usageEvent({ timestamp: clock - 59 * DAY_MS, request_id: 'recent' }));
  fixture.store.ingest(usageEvent({ timestamp: clock - 61 * DAY_MS, request_id: 'ancient' }));
  assert.equal(fixture.store.cleanup().events, 1);

  const later = clock + 12 * 60 * 60 * 1000;
  fixture.store.close();
  const reopened = createStore({ path: fixture.path, now: () => later });
  const ids = reopened.snapshot('month').recent.map((row) => row.requestId);
  assert.deepEqual(ids, ['recent']);
  reopened.close();
});

test('OpenCode and MiMo events contribute request, token, and model-priced cost totals', t => {
  const fixture = withStore(() => Date.parse('2026-09-10T18:30:00Z'));
  t.after(() => fixture.dispose());
  const { store } = fixture;
  store.ingest(usageEvent({ provider: 'OpenCode', model: 'gpt-5.4' }));
  store.ingest(usageEvent({ provider: 'MiMo', model: 'mimo-v2.5-pro',
    tokens: { input_tokens: 1000, output_tokens: 100, cached_tokens: 600, total_tokens: 1100 } }));
  store.ingest(usageEvent({ provider: 'mimo', model: 'mimo-v2.5',
    tokens: { input_tokens: 500, output_tokens: 200, cached_tokens: 100, total_tokens: 700 } }));
  const snapshot = store.snapshot('today');
  assert.equal(snapshot.totals.opencode.requests, 1);
  assert.equal(snapshot.totals.opencode.tokens, 30);
  assert.equal(snapshot.totals.opencode.costUsd, (10 * 2.5 + 20 * 15) / 1e6);
  assert.equal(snapshot.totals.mimo.requests, 2);
  assert.equal(snapshot.totals.mimo.tokens, 1800);
  const expected = (400 * 0.435 + 600 * 0.0036 + 100 * 0.87 + 400 * 0.14 + 100 * 0.0028 + 200 * 0.28) / 1e6;
  assert.ok(Math.abs(snapshot.totals.mimo.costUsd - expected) < 1e-12);
  assert.equal(snapshot.recent.filter(row => row.provider === 'mimo').length, 2);
  assert.ok(snapshot.recent.every(row => row.costUsd > 0));
});

test('legacy history gains the caller column before its index without losing events', t => {
  const clock = Date.parse('2026-09-10T18:30:00Z');
  const fixture = withStore(() => clock);
  let reopened;
  t.after(() => { reopened?.close(); fixture.dispose(); });
  fixture.store.ingest(usageEvent());
  fixture.store.close();

  const legacy = new DatabaseSync(fixture.path);
  try {
    legacy.exec('DROP INDEX events_by_caller; ALTER TABLE events DROP COLUMN caller');
    assert.equal(legacy.prepare('PRAGMA table_info(events)').all().some(column => column.name === 'caller'), false);
  } finally {
    legacy.close();
  }

  reopened = createStore({ path: fixture.path, now: () => clock,
    apiKeyAliases: [{ key: 'sk-migration-test', alias: 'Desk' }] });
  const existing = reopened.snapshot('today');
  assert.equal(existing.recent.length, 1);
  assert.equal(existing.recent[0].requestId, 'req-1');
  assert.equal(existing.recent[0].caller, null);
  reopened.ingest(usageEvent({ api_key: 'sk-migration-test', request_id: 'req-2' }));
  const snapshot = reopened.snapshot('today');
  assert.equal(snapshot.totals.codex.requests, 2);
  assert.equal(reopened.snapshot('today', snapshot.callers[0].id).totals.codex.requests, 1);
  reopened.close();

  reopened = createStore({ path: fixture.path, now: () => clock });
  assert.equal(reopened.snapshot('today').recent.length, 2);
  const inspect = new DatabaseSync(fixture.path, { readOnly: true });
  try {
    assert.equal(inspect.prepare('PRAGMA index_list(events)').all().some(index => index.name === 'events_by_caller'), true);
  } finally {
    inspect.close();
  }
});

test('cost totals sum request-specific context tiers and native Claude cached input', t => {
  setPricingCatalog({ data: [
    { id: 'test/tier-model-1', name: 'Test: Tier Model 1', pricing: { prompt: '0.000001', completion: '0',
      overrides: [{ min_prompt_tokens: 100, prompt: '0.000002' }] } },
    { id: 'anthropic/claude-example-1', name: 'Anthropic: Claude Example 1',
      pricing: { prompt: '0.00001', input_cache_read: '0.000001', completion: '0.00005' } },
  ] });
  const store = createStore({ path: ':memory:', now: () => Date.parse('2026-09-10T18:30:00Z') });
  t.after(() => { store.close(); setPricingCatalog({ data: [] }); });
  for (const input of [90, 90, 110]) store.ingest(usageEvent({ model: 'tier-model-1',
    tokens: { input_tokens: input, output_tokens: 0, cached_tokens: 0, total_tokens: input } }));
  store.ingest(usageEvent({ provider: 'claude', model: 'claude-example-1',
    tokens: { input_tokens: 2, output_tokens: 10, cached_tokens: 1000, total_tokens: 1012 } }));
  const snapshot = store.snapshot();
  assert.ok(Math.abs(snapshot.totals.codex.costUsd - 0.0004) < 1e-12);
  assert.equal(snapshot.totals.claude.costUsd, 0.00152);
  assert.equal(snapshot.totals.codex.models[0].requests, 3);
  assert.equal(snapshot.totals.codex.models[0].costUsd, snapshot.totals.codex.costUsd);
  assert.equal(snapshot.totals.claude.models[0].costUsd, 0.00152);
  assert.ok(Math.abs(snapshot.recent.filter(row => row.provider === 'codex').reduce((sum, row) => sum + row.costUsd, 0) - snapshot.totals.codex.costUsd) < 1e-12);
  assert.equal(snapshot.recent.find(row => row.provider === 'claude').costUsd, snapshot.totals.claude.costUsd);
});


test('model aggregates cover full period, isolate callers and preserve unknown pricing', t => {
  const store = createStore({ path: ':memory:', now: () => Date.parse('2026-09-10T18:30:00Z') });
  t.after(() => store.close());
  for (let i = 0; i < 35; i++) store.ingest(usageEvent({ model: 'gpt-5.4', request_id: 'model-' + i }));
  store.ingest(usageEvent({ model: 'unpriced-example', tokens: 2000 }));
  store.ingest(usageEvent({ model: null, alias: null, tokens: null }));
  store.ingest(usageEvent({ model: 'gpt-5.4', tokens: { total_tokens: 100 } }));
  store.ingest(usageEvent({ model: 'other-caller', api_key: 'sk-another-test-key', tokens: 500 }));
  store.ingest(usageEvent({ model: 'gpt-5.4', provider: 'claude' }));
  store.ingest(usageEvent({ model: 'earlier-week', timestamp: '2026-09-08T18:00:00Z', tokens: 6000 }));
  store.ingest(usageEvent({ model: 'future', timestamp: '2026-09-11T18:00:00Z' }));
  const all = store.snapshot('today');
  assert.equal(all.recent.length, 30);
  const total = all.totals.codex;
  assert.deepEqual(total.models.map(row => row.model), ['unpriced-example', 'gpt-5.4', 'other-caller', null]);
  assert.equal(total.models.find(row => row.model === 'gpt-5.4').requests, 36);
  assert.equal(total.models.find(row => row.model === 'gpt-5.4').pricedRequests, 35);
  assert.equal(total.models.find(row => row.model === null).tokens, null);
  assert.equal(total.models[0].costUsd, null);
  assert.equal(total.models.reduce((sum, row) => sum + (row.tokens ?? 0), 0), total.tokens);
  assert.equal(total.models.reduce((sum, row) => sum + row.requests, 0), total.requests);
  assert.ok(Math.abs(total.models.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) - total.costUsd) < 1e-12);
  const scoped = store.snapshot('today', callerId('sk-secret-value')).totals.codex;
  assert.equal(scoped.models.some(row => row.model === 'other-caller'), false);
  assert.equal(scoped.models.find(row => row.model === 'gpt-5.4').requests, 36);
  assert.equal(store.snapshot('week', callerId('sk-secret-value')).totals.codex.models[0].model, 'earlier-week');
  assert.deepEqual(store.snapshot('today', 'unknown-caller').totals.codex.models, []);
});

test('Claude historical input includes cache reads and writes for every request', t => {
  const clock = Date.parse('2026-09-10T18:30:00Z');
  const fixture = withStore(() => clock);
  let reopened;
  t.after(() => { reopened?.close(); fixture.dispose(); });
  // Native Claude: 2 uncached + 85,098 cache reads + 2,973 cache writes.
  // The 600 thinking tokens are already inside the 1,179 output tokens.
  for (let i = 0; i < 900; i++) fixture.store.ingest(usageEvent({
    provider: 'claude', model: 'claude-sonnet-4-5', request_id: 'claude-' + i,
    tokens: { input_tokens: 2, output_tokens: 1179, cached_tokens: 85098,
      reasoning_tokens: 600, total_tokens: 89252 },
  }));
  fixture.store.close();
  reopened = createStore({ path: fixture.path, now: () => clock });
  const snapshot = reopened.snapshot();
  assert.equal(snapshot.totals.claude.requests, 900);
  assert.equal(snapshot.totals.claude.inputTokens, 79265700);
  assert.equal(snapshot.totals.claude.outputTokens, 1061100);
  assert.equal(snapshot.totals.claude.tokens, 80326800);
  assert.equal(snapshot.totals.claude.reasoningTokens, 540000);
  assert.equal(snapshot.recent[0].inputTokens, 88073);
  assert.equal(snapshot.recent[0].outputTokens, 1179);
  assert.equal(snapshot.recent[0].cachedTokens, 85098);
  assert.equal(snapshot.recent[0].costUsd, (2 * 3 + 85098 * 0.3 + 1179 * 15) / 1e6);
  const db = new DatabaseSync(fixture.path, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT SUM(input_tokens) AS input FROM events').get().input, 1800);
  } finally { db.close(); }
});

test('Claude explicit cache reads take precedence over the legacy cache-write fallback', t => {
  const store = createStore({ path: ':memory:', now: () => Date.parse('2026-09-10T18:30:00Z') });
  t.after(() => store.close());
  for (const flat of [false, true]) {
    const tokens = { input_tokens: 2, output_tokens: 10, cached_tokens: 600,
      cache_read_tokens: 0, cache_read_tokens_present: true,
      cache_creation_tokens: 600, total_tokens: 612 };
    store.ingest(usageEvent({ provider: 'claude', model: 'claude-sonnet-4-5',
      ...(flat ? { tokens: undefined, ...tokens } : { tokens }) }));
  }
  const snapshot = store.snapshot();
  assert.equal(snapshot.totals.claude.inputTokens, 1204);
  assert.equal(snapshot.totals.claude.cachedTokens, 0);
  assert.ok(snapshot.recent.every(row => row.cachedTokens === 0 && row.inputTokens === 602));
});

test('Claude input falls back per request when source totals or splits are incomplete', t => {
  const store = createStore({ path: ':memory:', now: () => Date.parse('2026-09-10T18:30:00Z') });
  t.after(() => store.close());
  for (const [id, tokens] of [
    ['no-total', { input_tokens: 3, output_tokens: 20, cached_tokens: 50 }],
    ['short-total', { input_tokens: 3, output_tokens: 20, cached_tokens: 50, total_tokens: 23 }],
    ['no-output', { input_tokens: 3, cached_tokens: 50, total_tokens: 100 }],
    ['no-input', { output_tokens: 20, total_tokens: 120 }],
    ['unknown', { output_tokens: 20, cached_tokens: 50 }],
  ]) store.ingest(usageEvent({ provider: 'claude', request_id: id, tokens }));
  const snapshot = store.snapshot();
  assert.equal(snapshot.totals.claude.inputTokens, 259);
  assert.deepEqual(Object.fromEntries(snapshot.recent.map(row => [row.requestId, row.inputTokens])), {
    unknown: null, 'no-input': 100, 'no-output': 53, 'short-total': 53, 'no-total': 53,
  });
});
