import test from 'node:test';
import assert from 'node:assert/strict';

import { createQuotaService } from './quota.js';

const CLOCK = Date.parse('2026-09-10T18:30:00Z');

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// Synthetic fixtures. They follow the documented upstream field names, but the
// live payloads have not been verified, so these tests only pin our handling of
// known shapes and of unrecognized ones.
function apiCallEnvelope(payload, status = 200, header = {}) {
  return jsonResponse({ status_code: status, header, body: JSON.stringify(payload) });
}

function codexPayload(usedPercent, { resetAt = '2026-09-11T00:00:00Z' } = {}) {
  return {
    plan_type: 'pro',
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: Math.floor(Date.parse(resetAt) / 1000),
      },
    },
  };
}

function claudePayload(utilization) {
  return {
    five_hour: { utilization, resets_at: '2026-09-10T22:00:00Z' },
    seven_day: { utilization: utilization / 2, resets_at: '2026-09-14T00:00:00Z' },
  };
}

function antigravityPayload() {
  return {
    groups: [
      { displayName: 'Gemini', buckets: [
        { bucketId: 'gemini-5h', remainingFraction: 0.5, window: '5h', resetTime: '2026-09-10T20:00:00Z' },
        { bucketId: 'gemini-weekly', remainingFraction: 0.25, window: 'weekly' },
      ] },
      { displayName: 'Claude', buckets: [{ remainingFraction: 0.9, window: '5h' }] },
    ],
  };
}

function managementStub({ files, quotaFor, discoveryStatus = 200, discoveryHeaders = {} }) {
  const calls = { discovery: 0, apiCall: 0, bodies: [] };
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(String(url));
    if (pathname.endsWith('/auth-files')) {
      calls.discovery += 1;
      if (discoveryStatus !== 200) return jsonResponse({ error: 'denied' }, discoveryStatus, discoveryHeaders);
      return jsonResponse({ files });
    }
    if (pathname.endsWith('/api-call')) {
      calls.apiCall += 1;
      const body = JSON.parse(init.body);
      calls.bodies.push(body);
      return quotaFor(body);
    }
    return jsonResponse({ error: 'not found' }, 404);
  };
  return { calls, fetchImpl };
}

function service(options) {
  return createQuotaService({
    baseUrl: 'https://proxy.example.com/v0/management',
    managementKey: 'management-key',
    now: () => CLOCK,
    ...options,
  });
}

const codexFiles = [
  { provider: 'codex', auth_index: 'codex-5', name: 'codex-5.json' },
  { provider: 'codex', auth_index: 'codex-20', name: 'codex-20.json' },
  { provider: 'xai', auth_index: 'xai-1', name: 'xai-1.json' },
];

test('weights Codex accounts by stable identifier', async () => {
  const stub = managementStub({
    files: codexFiles,
    quotaFor: (body) =>
      apiCallEnvelope(body.auth_index === 'codex-5' ? codexPayload(20) : codexPayload(80)),
  });
  const quota = service({ codexWeights: { 'codex-5': 5, 'codex-20': 20 }, fetchImpl: stub.fetchImpl });

  await quota.refresh();
  const snapshot = quota.snapshot();
  const primary = snapshot.codex.windows.find((window) => window.id === 'primary');

  // 80% remaining on x5 and 20% on x20: 32% weighted remaining.
  assert.equal(primary.remainingPercent, (5 * 80 + 20 * 20) / 25);
  assert.equal(primary.observedAccounts, 2);
  assert.equal(primary.totalAccounts, 2);
  assert.equal(primary.stale, false);
  assert.equal(primary.observedAt, '2026-09-10T18:30:00.000Z');
  assert.equal(primary.nextResetAt, '2026-09-11T00:00:00.000Z');
  assert.equal(snapshot.codex.accounts, 2);
  assert.equal(snapshot.xai, undefined);
  assert.equal(stub.calls.apiCall, 2);
  const headers = stub.calls.bodies[0].header;
  assert.equal(headers.Authorization, 'Bearer $TOKEN$');
});

test('reports exhausted accounts and provider coverage', async () => {
  const files = [
    ...codexFiles,
    { provider: 'claude', auth_index: 'claude-1', name: 'claude.json' },
    { provider: 'antigravity', auth_index: 'ag-1', name: 'ag-1.json', project_id: 'proj-1' },
    { provider: 'antigravity', auth_index: 'ag-2', name: 'ag-2.json', project_id: 'proj-1' },
  ];
  const stub = managementStub({
    files,
    quotaFor: (body) => {
      if (body.auth_index === 'codex-5') return apiCallEnvelope(codexPayload(100));
      if (body.auth_index === 'codex-20') return apiCallEnvelope(codexPayload(0));
      if (body.auth_index === 'claude-1') return apiCallEnvelope(claudePayload(40));
      if (body.auth_index === 'ag-1') return apiCallEnvelope(antigravityPayload());
      return jsonResponse({ error: 'boom' }, 500);
    },
  });
  const quota = service({ codexWeights: { 'codex-5': 5, 'codex-20': 20 }, fetchImpl: stub.fetchImpl });

  await quota.refresh();
  const snapshot = quota.snapshot();

  assert.equal(snapshot.codex.exhausted, 1);
  assert.equal(snapshot.codex.windows.find((window) => window.id === 'primary').remainingPercent, 80);
  assert.equal(snapshot.claude.windows.find((window) => window.id === 'five-hour').remainingPercent, 60);
  assert.equal(snapshot.claude.windows.find((window) => window.id === 'seven-day').remainingPercent, 80);

  const fiveHour = snapshot.antigravity.windows.find((window) => window.id === 'gemini-five-hour');
  assert.equal(fiveHour.remainingPercent, 50);
  assert.equal(fiveHour.model, 'Gemini');
  assert.equal(fiveHour.label, '5-hour');
  assert.equal(snapshot.antigravity.windows.find((window) => window.id === 'gemini-weekly').remainingPercent, 25);
  assert.equal(snapshot.antigravity.accounts, 2);
  assert.equal(snapshot.antigravity.observedAccounts, 1);
  assert.equal(snapshot.antigravity.message, '1 of 2 accounts failed to refresh.');

  const antigravityBody = stub.calls.bodies.find((body) => body.auth_index === 'ag-1');
  assert.equal(antigravityBody.url.includes('retrieveUserQuotaSummary'), true);
  assert.equal(antigravityBody.method, 'POST');
  assert.equal(JSON.parse(antigravityBody.data).project, 'proj-1');
});

test('keeps the last successful reading when a refresh fails', async () => {
  let failing = false;
  const stub = managementStub({
    files: codexFiles,
    quotaFor: () => (failing ? jsonResponse({ error: 'boom' }, 500) : apiCallEnvelope(codexPayload(20))),
  });
  const quota = service({ codexWeights: { 'codex-5': 5, 'codex-20': 20 }, fetchImpl: stub.fetchImpl });

  await quota.refresh();
  const before = quota.snapshot().codex.windows.find((window) => window.id === 'primary');
  assert.equal(before.remainingPercent, 80);

  failing = true;
  await quota.refresh();
  const after = quota.snapshot().codex.windows.find((window) => window.id === 'primary');
  assert.equal(after.remainingPercent, 80);
  assert.equal(after.stale, true);
  assert.equal(after.observedAt, before.observedAt);
  assert.match(after.message, /stale/i);
  assert.equal(quota.snapshot().codex.message, '2 of 2 accounts failed to refresh.');
});

test('excludes accounts without a configured Codex weight', async () => {
  const stub = managementStub({
    files: [codexFiles[0]],
    quotaFor: () => apiCallEnvelope(codexPayload(20)),
  });
  const quota = service({ codexWeights: {}, fetchImpl: stub.fetchImpl });

  await quota.refresh();
  const primary = quota.snapshot().codex.windows.find((window) => window.id === 'primary');
  assert.equal(primary.remainingPercent, null);
  assert.equal(primary.observedAccounts, 0);
  assert.equal(primary.totalAccounts, 1);
  assert.match(primary.message, /weight/i);
});

test('stops refreshing after a management authentication failure', async () => {
  const stub = managementStub({ files: [], discoveryStatus: 401 });
  const quota = service({ codexWeights: {}, fetchImpl: stub.fetchImpl });

  await quota.refresh();
  assert.match(quota.snapshot().codex.message, /authentication failed/i);
  await quota.refresh();
  assert.equal(stub.calls.discovery, 1);
  assert.equal(stub.calls.apiCall, 0);
});

test('honors Retry-After before the next cycle', async () => {
  const stub = managementStub({
    files: [],
    discoveryStatus: 429,
    discoveryHeaders: { 'retry-after': '60' },
  });
  const quota = service({ codexWeights: {}, fetchImpl: stub.fetchImpl });

  await quota.refresh();
  await quota.refresh();
  assert.equal(stub.calls.discovery, 1);
});

test('reports Antigravity Gemini windows only, or Unknown when unrecognized', async () => {
  const files = [{ provider: 'antigravity', auth_index: 'ag-1', name: 'ag-1.json', project_id: 'p' }];
  const recognized = managementStub({ files, quotaFor: () => apiCallEnvelope(antigravityPayload()) });
  const quota = service({ codexWeights: {}, fetchImpl: recognized.fetchImpl });
  await quota.refresh();
  const ids = quota.snapshot().antigravity.windows.map((window) => window.id);
  assert.deepEqual(ids, ['gemini-five-hour', 'gemini-weekly']);

  const unknown = managementStub({ files, quotaFor: () => apiCallEnvelope({ unexpected: true }) });
  const other = service({ codexWeights: {}, fetchImpl: unknown.fetchImpl });
  await other.refresh();
  const windows = other.snapshot().antigravity.windows;
  assert.deepEqual(windows.map((window) => window.id), ['gemini-five-hour', 'gemini-weekly']);
  assert.equal(windows.every((window) => window.remainingPercent === null), true);
  assert.match(windows[0].message, /not both identified/i);
});

test('reports Unknown windows before the first refresh', () => {
  const quota = service({ codexWeights: {}, fetchImpl: async () => jsonResponse({ files: [] }) });
  const snapshot = quota.snapshot();
  assert.equal(snapshot.codex.accounts, 0);
  assert.deepEqual(
    snapshot.codex.windows.map((window) => window.id),
    ['primary', 'secondary'],
  );
  assert.equal(snapshot.codex.windows.every((window) => window.remainingPercent === null), true);
  assert.equal(snapshot.codex.exhausted, 0);
});

test('preserves Gemini model windows without inventing five-hour or weekly capacity', async () => {
  const stub = managementStub({ files: [{ provider: 'antigravity', auth_index: 'ag', project_id: 'p' }],
    quotaFor: () => apiCallEnvelope({ models: {
      'gemini-pro': { quotaInfo: { remainingFraction: 0.2, resetTime: '2026-09-10T23:30:00Z' } },
      'gemini-flash': { quotaInfo: { remainingFraction: 0.9 } },
      'claude-sonnet': { quotaInfo: { remainingFraction: 0 } },
    } }) });
  const quota = service({ fetchImpl: stub.fetchImpl });
  await quota.refresh();
  const windows = quota.snapshot().antigravity.windows;
  assert.equal(windows.find(w => w.id === 'gemini-five-hour').remainingPercent, null);
  assert.equal(windows.find(w => w.id === 'gemini-weekly').remainingPercent, null);
  assert.equal(windows.find(w => w.id === 'model:gemini-pro').remainingPercent, 20);
  assert.equal(windows.find(w => w.id === 'model:gemini-flash').remainingPercent, 90);
  assert.equal(windows.some(w => /claude/.test(w.model)), false);
});

test('different Codex durations and model scopes are never averaged together', async () => {
  const stub = managementStub({ files: codexFiles, quotaFor: body => {
    const payload = codexPayload(body.auth_index === 'codex-5' ? 20 : 80);
    if (body.auth_index === 'codex-20') payload.rate_limit.primary_window.limit_window_seconds = 86400;
    payload.additional_rate_limits = [{ limit_name: 'special-model', rate_limit: codexPayload(50).rate_limit }];
    return apiCallEnvelope(payload);
  } });
  const quota = service({ fetchImpl: stub.fetchImpl, codexWeights: { 'codex-5': 5, 'codex-20': 20 } });
  await quota.refresh();
  const windows = quota.snapshot().codex.windows;
  assert.equal(windows.find(w => w.id === 'primary').remainingPercent, 80);
  assert.equal(windows.find(w => w.id === 'primary-86400s').remainingPercent, 20);
  assert.equal(windows.find(w => w.id === 'special-model:primary').remainingPercent, 50);
});

test('omitted readings stay stale and timestamps use the oldest included reading', async () => {
  let current = CLOCK;
  let omit = false;
  const stub = managementStub({ files: codexFiles, quotaFor: body =>
    apiCallEnvelope(omit && body.auth_index === 'codex-5' ? {} : codexPayload(20)) });
  const quota = service({ now: () => current, fetchImpl: stub.fetchImpl, codexWeights: { 'codex-5': 5, 'codex-20': 20 } });
  await quota.refresh();
  current += 5000;
  omit = true;
  await quota.refresh();
  const window = quota.snapshot().codex.windows.find(w => w.id === 'primary');
  assert.equal(window.remainingPercent, 80);
  assert.equal(window.stale, true);
  assert.equal(window.observedAt, new Date(CLOCK).toISOString());
});

test('throttling stops the current cycle and network error details stay private', async () => {
  const stub = managementStub({ files: codexFiles,
    quotaFor: () => apiCallEnvelope({}, 429, { 'Retry-After': ['60'] }) });
  const quota = service({ fetchImpl: stub.fetchImpl, codexWeights: { 'codex-5': 5, 'codex-20': 20 } });
  await quota.refresh();
  await quota.refresh();
  assert.equal(stub.calls.apiCall, 1);
  assert.equal(stub.calls.discovery, 1);
  const privateQuota = service({ fetchImpl: async () => { throw new Error('api_key=synthetic-sensitive-value'); } });
  await privateQuota.refresh();
  assert.equal(JSON.stringify(privateQuota.snapshot()).includes('synthetic-sensitive-value'), false);
});

test('refreshes share one request and reject out-of-range quota', async () => {
  let release;
  let count = 0;
  const quota = service({ fetchImpl: () => { count++; return new Promise(resolve => { release = resolve; }); } });
  const first = quota.refresh();
  const second = quota.refresh();
  assert.equal(count, 1);
  release(jsonResponse({ files: [] }));
  await Promise.all([first, second]);
  const stub = managementStub({ files: [codexFiles[0]], quotaFor: () => apiCallEnvelope(codexPayload(120)) });
  const invalid = service({ fetchImpl: stub.fetchImpl, codexWeights: { 'codex-5': 5 } });
  await invalid.refresh();
  assert.equal(invalid.snapshot().codex.windows[0].remainingPercent, null);
});
