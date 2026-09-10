import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, managementBase } from '../src/config.js';
import { startApp } from '../src/server.js';

test('management URLs append the path once and reject credentials and query secrets', () => {
  for (const input of ['https://example.com', 'https://example.com/v0/management/', 'https://example.com/v0/management/v0/management']) {
    assert.equal(managementBase(input), 'https://example.com/v0/management');
  }
  assert.equal(managementBase('https://example.com/proxy'), 'https://example.com/proxy/v0/management');
  for (const input of ['https://secret@example.com', 'https://example.com?key=secret', 'file:///etc/passwd']) assert.throws(() => managementBase(input));
});

test('config validates weights and RESP and demo isolates credentials and persistent history', () => {
  const config = readConfig({ MANAGEMENT_KEY: 'secret', CLIPROXYAPI_BASE_URL: 'invalid', DATA_PATH: 'live.sqlite' }, ['--demo']);
  assert.deepEqual(config, { demo: true, host: '127.0.0.1', port: 8787 });
  assert.throws(() => readConfig({ CODEX_ACCOUNT_WEIGHTS: '{"id":1}' }, []));
  assert.throws(() => readConfig({ CLIPROXYAPI_RESP_URL: 'https://proxy.example.com' }, []));
  assert.throws(() => readConfig({ CLIPROXYAPI_RESP_URL: 'redis://secret@example.com' }, []));
  assert.throws(() => readConfig({ PORT: '-1' }, []));
});

test('HTTP demo provides period totals with current feed and read-only safe routes', async t => {
  const app = await startApp({ demo: true, host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const todayResponse = await fetch(`${base}/api/dashboard`);
  const today = await todayResponse.json();
  const week = await fetch(`${base}/api/dashboard?period=week`).then(r => r.json());
  assert.equal(today.demo, true);
  assert.equal(today.period, 'today');
  assert.equal(today.timezone, 'America/Chicago');
  assert.ok(week.totals.codex.tokens > today.totals.codex.tokens);
  assert.equal(today.recent[0].model, week.recent[0].model);
  assert.equal(today.recent.length, 30);
  assert.equal(todayResponse.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/api/dashboard?period=year`)).status, 400);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/v0/management/auth-files`)).status, 404);
  assert.equal((await fetch(`${base}/api/dashboard`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});
