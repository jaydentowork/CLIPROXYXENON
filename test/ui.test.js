import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { callerId } from '../src/callers.js';
import { demoSnapshot } from '../src/demo.js';

// This DOM fixture exercises the actual polling script. Layout uses real-browser QA.
function browserFixture(storedProviders = null, { storedKey = null, cryptoImpl = webcrypto, storage = {} } = {}) {
  const saved = new Map();
  const digests = [];
  if (storedKey !== null) saved.set('cliproxyapi-monitor.api-key', storedKey);
  if (storedProviders !== null) saved.set('cliproxyapi-monitor.providers', storedProviders);
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.style = { setProperty() {} }; this.classList = { add() {}, remove() {} }; this.offsetWidth = 0; this.scrollTop = 0; this.offsetTop = 0; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    focus() { context.document.activeElement = this; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  const nodes = new Map();
  const buttons = ['today', 'week', 'month'].map(period => { const node = new Element(); node.dataset.period = period; return node; });
  const events = {};
  const requests = [];
  const timers = new Map();
  const context = {
    document: { getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
      createElement: () => new Element(), querySelectorAll: () => buttons, addEventListener() {}, fullscreenElement: null },
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    MutationObserver: class { observe() {} },
    URLSearchParams,
    localStorage: { getItem: key => { if (storage.fail) throw new Error('blocked'); return saved.get(key) ?? null; },
      setItem: (key, value) => { if (storage.fail) throw new Error('blocked'); saved.set(key, value); },
      removeItem: key => { if (storage.fail) throw new Error('blocked'); saved.delete(key); } },
    crypto: cryptoImpl?.subtle ? { subtle: { digest: (...args) => { const result = cryptoImpl.subtle.digest(...args); digests.push(result); return result; } } } : cryptoImpl,
    TextEncoder, Uint8Array, btoa,
    Intl, Date, Map, Set, Error, Number, Array, Object, String, Boolean, AbortController, AbortSignal,
    fetch: (url, init) => new Promise(resolve => requests.push({ url, init, resolve })),
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  runInNewContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  const respond = async (index, payload, status = 200) => {
    requests[index].resolve({ ok: status === 200, status, json: async () => payload });
    await new Promise(resolve => setImmediate(resolve));
  };
  const settle = async () => { await Promise.all(digests); await new Promise(resolve => setImmediate(resolve)); };
  return { nodes, buttons, events, requests, timers, respond, saved, settle };
}

test('rapid period changes discard old responses and preserve selection on refresh', async () => {
  const ui = browserFixture();
  ui.buttons[1].listeners.click();
  ui.buttons[2].listeners.click();
  assert.equal(ui.requests[0].init.signal.aborted, true);
  assert.equal(ui.requests[1].init.signal.aborted, true);
  await ui.respond(2, demoSnapshot('month'));
  const providers = ui.nodes.get('providers');
  const monthTokens = providers.children[0].children[0].children[1].children[1].children[0].textContent;
  await ui.respond(0, demoSnapshot('today'));
  await ui.respond(1, demoSnapshot('week'));
  assert.equal(providers.children[0].children[0].children[1].children[1].children[0].textContent, monthTokens);
  assert.equal(ui.buttons[2].attributes['aria-pressed'], 'true');
  const timer = [...ui.timers.values()].at(-1);
  assert.equal(timer.ms, 5000);
  timer.fn();
  assert.match(ui.requests.at(-1).url, /period=month/);
});

test('API failure preserves values and touch holds feed rows stable', async () => {
  const ui = browserFixture();
  await ui.respond(0, demoSnapshot('today'));
  const feed = ui.nodes.get('feed-list');
  const original = feed.children[0];
  feed.listeners.pointerdown();
  [...ui.timers.values()].at(-1).fn();
  await ui.respond(1, demoSnapshot('today', Date.now() + 10000));
  assert.equal(feed.children[0], original);
  ui.events.pointerup();
  assert.notEqual(feed.children[0], original);
  const last = feed.children[0];
  [...ui.timers.values()].at(-1).fn();
  await ui.respond(2, {}, 503);
  assert.equal(feed.children[0], last);
  assert.equal(ui.nodes.get('banner').hidden, false);
  assert.match(ui.nodes.get('banner').textContent, /last reading/);
});

test('provider picker supports hover, touch controls, Escape, and independent persisted slots', async () => {
  const ui = browserFixture();
  await ui.respond(0, demoSnapshot('today'));
  const slots = ui.nodes.get('providers').children;
  const first = slots[0];
  const front = first.children[0];
  const picker = first.children[1];
  const change = front.children[0].children[1].children[1];
  first.listeners.pointerenter({ pointerType: 'touch' });
  assert.equal(picker.attributes['aria-hidden'], 'true');
  first.listeners.pointerenter({ pointerType: 'mouse' });
  assert.equal(picker.attributes['aria-hidden'], 'false');
  assert.equal(front.inert, true);
  first.listeners.pointerleave();
  assert.equal(picker.attributes['aria-hidden'], 'true');
  change.listeners.click();
  assert.equal(picker.inert, false);
  first.listeners.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(picker.inert, true);

  change.listeners.click();
  picker.children[2].children[2].listeners.click(); // Codex
  assert.equal(front.children[0].children[0].textContent, 'Codex');
  assert.equal(front.children[1].children[0].children[0].textContent, '214');
  assert.equal(slots[1].children[0].children[0].children[0].textContent, 'Claude');
  assert.equal(picker.attributes['aria-hidden'], 'true');
  assert.deepEqual(JSON.parse(ui.saved.get('cliproxyapi-monitor.providers')), ['codex', 'claude', 'codex']);

  const restored = browserFixture(ui.saved.get('cliproxyapi-monitor.providers'));
  await restored.respond(0, demoSnapshot('today'));
  assert.equal(restored.nodes.get('providers').children[0].children[0].children[0].children[0].textContent, 'Codex');
});

test('provider changes during a pending period never show another provider totals', async () => {
  const ui = browserFixture();
  await ui.respond(0, demoSnapshot('today'));
  ui.buttons[2].listeners.click();
  const first = ui.nodes.get('providers').children[0];
  first.children[1].children[2].children[3].listeners.click(); // OpenCode
  const front = first.children[0];
  assert.equal(front.children[0].children[0].textContent, 'OpenCode');
  assert.equal(front.children[1].children[0].children[0].textContent, 'Unknown');
  assert.equal(front.children[4].children.length, 0);
  const month = demoSnapshot('month');
  await ui.respond(1, month);
  assert.equal(front.children[1].children[0].children[0].textContent, month.totals.opencode.requests.toLocaleString('en-US'));
});

test('invalid saved provider ids fall back to the default slot', () => {
  const ui = browserFixture('["removed-provider","mimo","codex"]');
  const slots = ui.nodes.get('providers').children;
  assert.equal(slots[0].children[0].children[0].children[0].textContent, 'Antigravity');
  assert.equal(slots[1].children[0].children[0].children[0].textContent, 'Mimo');
});

test('usage-only cards show requests and tokens above Input, Output, and Est. cost', async () => {
  const ui = browserFixture('["opencode","mimo","codex"]');
  const payload = demoSnapshot('today');
  payload.totals.mimo.costUsd = 1234;
  await ui.respond(0, payload);
  const slots = ui.nodes.get('providers').children;
  for (const slot of slots.slice(0, 2)) {
    const front = slot.children[0];
    assert.deepEqual(front.children[1].children.map(stat => stat.children[1].textContent), ['Requests', 'Tokens']);
    assert.equal(front.children[2].hidden, false);
    assert.deepEqual(front.children[2].children.map(stat => stat.children[0].textContent), ['Input', 'Output', 'Est. cost']);
    assert.equal(front.children[3].hidden, true);
    assert.equal(front.children[4].hidden, true);
    assert.equal(front.children[5].hidden, true);
  }
  assert.equal(slots[1].children[0].children[2].children[2].children[1].textContent, '$1.2K');
  slots[0].children[1].children[2].children[1].listeners.click(); // Claude
  const restored = slots[0].children[0];
  assert.deepEqual(restored.children[1].children.map(stat => stat.children[1].textContent), ['Requests', 'Tokens', 'Cache hit']);
  assert.equal(restored.children[2].hidden, false);
  assert.equal(restored.children[3].hidden, false);
  assert.equal(restored.children[4].hidden, false);
  assert.equal(restored.children[2].children[2].children[0].textContent, 'Est. cost');
});

test('API-key filter saves locally, sends only its hash, clears old data, and survives reload', async () => {
  const key = 'sk-browser-test-key';
  const ui = browserFixture();
  await ui.respond(0, demoSnapshot('today'));
  ui.nodes.get('feed-list').listeners.pointerdown(); // Even a held feed must clear on key change.
  ui.nodes.get('api-key').value = key;
  await ui.nodes.get('apply-key').listeners.click();
  assert.equal(ui.saved.get('cliproxyapi-monitor.api-key'), key);
  assert.equal(new URLSearchParams(ui.requests[1].url.split('?')[1]).get('caller'), callerId(key));
  assert.equal(JSON.stringify(ui.requests).includes(key), false);
  assert.equal(ui.nodes.get('feed-list').children.length, 0);
  const front = ui.nodes.get('providers').children[0].children[0];
  assert.equal(front.children[1].children[0].children[0].textContent, 'Unknown');
  await ui.respond(1, demoSnapshot('today', Date.now(), callerId(key))); // No alias, no matching requests.
  assert.equal(ui.nodes.get('feed-list').children.length, 0);
  assert.match(ui.nodes.get('feed-empty').textContent, /this API key/);
  assert.equal(ui.nodes.get('feed-filter').hidden, false);
  assert.equal(ui.requests.length, 2); // No fallback request for all users.

  const restored = browserFixture(null, { storedKey: key });
  assert.equal(restored.requests.length, 0); // Hash first; never load unfiltered usage.
  assert.equal(restored.nodes.get('clear-key').disabled, true);
  await restored.nodes.get('clear-key').listeners.click();
  assert.equal(restored.saved.get('cliproxyapi-monitor.api-key'), key);
  restored.buttons[1].listeners.click();
  assert.equal(restored.requests.length, 0);
  await restored.settle();
  assert.equal(restored.requests.length, 1);
  assert.match(restored.nodes.get('feed-empty').textContent, /this API key/);
  assert.match(restored.requests[0].url, /period=week/);
  assert.equal(new URLSearchParams(restored.requests[0].url.split('?')[1]).get('caller'), callerId(key));
  await restored.nodes.get('clear-key').listeners.click();
  assert.equal(restored.saved.has('cliproxyapi-monitor.api-key'), false);
  assert.equal(restored.nodes.get('api-key').value, '');
  assert.equal(restored.requests[0].init.signal.aborted, true);
  assert.equal(restored.requests[1].url.includes('caller='), false);
  await restored.respond(0, demoSnapshot('week', Date.now(), callerId(key)));
  assert.equal(restored.nodes.get('feed-list').children.length, 0);
  await restored.respond(1, demoSnapshot('week'));
  assert.equal(restored.nodes.get('feed-list').children.length, 30);
});

test('unavailable crypto or localStorage never silently drops a saved filter', async () => {
  const key = 'sk-saved-test-key';
  const unavailable = browserFixture(null, { storedKey: key, cryptoImpl: {} });
  await unavailable.settle();
  assert.equal(unavailable.requests.length, 0);
  assert.match(unavailable.nodes.get('key-status').textContent, /HTTPS or localhost/);
  const storage = { fail: true };
  const blocked = browserFixture(null, { storedKey: key, storage });
  await blocked.settle();
  assert.equal(blocked.requests.length, 0);
  assert.match(blocked.nodes.get('key-status').textContent, /site storage/);

  const activeStorage = {};
  const active = browserFixture(null, { storedKey: key, storage: activeStorage });
  await active.settle();
  activeStorage.fail = true;
  await active.nodes.get('clear-key').listeners.click();
  assert.equal(active.requests.length, 1);
  assert.equal(active.saved.get('cliproxyapi-monitor.api-key'), key);
  assert.match(active.nodes.get('key-status').textContent, /storage is unavailable/);
});

test('Claude cache hit uses total prompt size when native input excludes cache reads', async () => {
  const ui = browserFixture();
  const payload = demoSnapshot('today');
  payload.totals.claude.inputTokens = 100;
  payload.totals.claude.cachedTokens = 900;
  await ui.respond(0, payload);
  const front = ui.nodes.get('providers').children[1].children[0];
  assert.equal(front.children[1].children[2].children[0].textContent, '90%');
});
