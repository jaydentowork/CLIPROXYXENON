import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { demoSnapshot } from '../src/demo.js';

// This DOM fixture exercises the actual polling script. Layout uses real-browser QA.
function browserFixture() {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.style = { setProperty() {} }; this.scrollTop = 0; this.offsetTop = 0; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const nodes = new Map();
  const buttons = ['today', 'week', 'month'].map(period => { const node = new Element(); node.dataset.period = period; return node; });
  const events = {};
  const requests = [];
  const timers = new Map();
  const context = {
    document: { getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
      createElement: () => new Element(), querySelectorAll: () => buttons },
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    Intl, Date, Map, Set, Error, Number, Array, Object, String, AbortController, AbortSignal,
    fetch: (url, init) => new Promise(resolve => requests.push({ url, init, resolve })),
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  runInNewContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  const respond = async (index, payload, status = 200) => {
    requests[index].resolve({ ok: status === 200, status, json: async () => payload });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { nodes, buttons, events, requests, timers, respond };
}

test('rapid period changes discard old responses and preserve selection on refresh', async () => {
  const ui = browserFixture();
  ui.buttons[1].listeners.click();
  ui.buttons[2].listeners.click();
  assert.equal(ui.requests[0].init.signal.aborted, true);
  assert.equal(ui.requests[1].init.signal.aborted, true);
  await ui.respond(2, demoSnapshot('month'));
  const providers = ui.nodes.get('providers');
  const monthTokens = providers.children[0].children[1].children[1].children[0].textContent;
  await ui.respond(0, demoSnapshot('today'));
  await ui.respond(1, demoSnapshot('week'));
  assert.equal(providers.children[0].children[1].children[1].children[0].textContent, monthTokens);
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
