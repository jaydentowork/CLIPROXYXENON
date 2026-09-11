import test from 'node:test';
import assert from 'node:assert/strict';
import { callerId, createCallerDirectory, parseApiKeyAliases } from './callers.js';
import { createStore } from './storage.js';

const aliases = parseApiKeyAliases(JSON.stringify({ 'sk-desk-secret': 'Desk', 'sk-agents-secret': 'Agents' }));

function event(overrides = {}) {
  return {
    timestamp: '2026-09-10T18:00:00Z', provider: 'codex', model: 'gpt-5',
    tokens: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }, failed: false, ...overrides,
  };
}

test('the directory exposes aliases and opaque ids only', () => {
  const directory = createCallerDirectory(aliases);
  const listed = directory.list();
  assert.deepEqual(listed.map(entry => entry.alias), ['Desk', 'Agents']);
  for (const entry of listed) {
    assert.match(entry.id, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(JSON.stringify(entry).includes('secret'), false);
  }
  assert.equal(directory.resolve('sk-desk-secret'), callerId('sk-desk-secret'));
  assert.equal(directory.aliasFor(directory.resolve('sk-unknown')), null);
  assert.equal(directory.isKnown(directory.resolve('sk-unknown')), false);
});

test('snapshots filter by caller id and never carry a key', () => {
  const store = createStore({ path: ':memory:', apiKeyAliases: aliases, now: () => Date.parse('2026-09-10T18:30:00Z') });
  store.ingest(event({ api_key: 'sk-desk-secret' }));
  store.ingest(event({ api_key: 'sk-agents-secret', tokens: { input_tokens: 100, output_tokens: 200, total_tokens: 300 } }));
  store.ingest(event({ api_key: 'sk-unknown' }));
  store.ingest(event({}));

  const all = store.snapshot('today');
  assert.equal(all.totals.codex.requests, 4);
  assert.equal(all.caller, null);
  assert.deepEqual(all.callers.map(entry => entry.alias), ['Desk', 'Agents']);
  assert.deepEqual(all.recent.map(row => row.caller), [null, null, 'Agents', 'Desk']);

  const desk = all.callers.find(entry => entry.alias === 'Desk');
  const filtered = store.snapshot('today', desk.id);
  assert.equal(filtered.caller, desk.id);
  assert.equal(filtered.totals.codex.requests, 1);
  assert.equal(filtered.totals.codex.tokens, 30);
  assert.equal(filtered.recent.length, 1);

  // Pasted keys work without configured aliases; unknown keys match no usage.
  assert.equal(store.snapshot('today', callerId('sk-unknown')).totals.codex.requests, 1);
  assert.equal(store.snapshot('today', 'nonsense').totals.codex.requests, 0);

  assert.equal(store.snapshot('today', callerId('sk-nonmatching')).recent.length, 0);
  assert.equal(store.snapshot('today', callerId('sk-unknown')).totals.codex.costUsd, filtered.totals.codex.costUsd);
  const text = JSON.stringify([all, filtered]);
  for (const secret of ['sk-desk-secret', 'sk-agents-secret', 'sk-unknown']) assert.equal(text.includes(secret), false);
  store.close();
});
