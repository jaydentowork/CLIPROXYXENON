import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

import { createStore } from './storage.js';

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
  const fixture = withStore();
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
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  });
  assert.deepEqual(store.snapshot('today').totals.claude, {
    requests: 1,
    tokens: 30,
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: 0,
    reasoningTokens: 0,
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

  const reopened = createStore({ path: fixture.path, now: () => clock + 1000 });
  const snapshot = reopened.snapshot('today');
  assert.equal(snapshot.trackingSince, trackingSince);
  assert.equal(snapshot.recent.length, 1);
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
