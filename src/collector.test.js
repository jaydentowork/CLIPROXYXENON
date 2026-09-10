import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { startCollector } from './collector.js';
import { createStore } from './storage.js';

const simpleFrame = (text) => Buffer.from(`+${text}\r\n`);
const errorFrame = (text) => Buffer.from(`-${text}\r\n`);
const integerFrame = (value) => Buffer.from(`:${value}\r\n`);
const bulkFrame = (text) => Buffer.from(`$${Buffer.byteLength(text)}\r\n${text}\r\n`);
const arrayFrame = (...parts) => Buffer.concat([Buffer.from(`*${parts.length}\r\n`), ...parts]);
const messageFrame = (channel, payload) =>
  arrayFrame(bulkFrame('message'), bulkFrame(channel), bulkFrame(payload));
const subscribeFrame = (channel, count) =>
  arrayFrame(bulkFrame('subscribe'), bulkFrame(channel), integerFrame(count));

// Parses a client command without sharing code with the collector, so the test
// observes exactly what goes over the wire.
function parseCommand(buffer) {
  if (buffer.length === 0 || buffer[0] !== 0x2a) return null;
  const headerEnd = buffer.indexOf('\r\n', 1);
  if (headerEnd === -1) return null;
  const count = Number(buffer.toString('utf8', 1, headerEnd));
  let cursor = headerEnd + 2;
  const args = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer[cursor] !== 0x24) return null;
    const lengthEnd = buffer.indexOf('\r\n', cursor + 1);
    if (lengthEnd === -1) return null;
    const length = Number(buffer.toString('utf8', cursor + 1, lengthEnd));
    const start = lengthEnd + 2;
    if (buffer.length < start + length + 2) return null;
    args.push(buffer.toString('utf8', start, start + length));
    cursor = start + length + 2;
  }
  return { args, offset: cursor };
}

async function startFakeServer(handlers = {}) {
  const state = { commands: [], connections: 0, subscriptions: 0, sockets: new Set() };
  const server = net.createServer((socket) => {
    state.connections += 1;
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let authed = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parseCommand(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.offset);
        const [name, ...args] = parsed.args;
        state.commands.push(parsed.args);
        const command = String(name).toUpperCase();
        if (command === 'AUTH') {
          if (handlers.rejectAuth) {
            socket.write(errorFrame('ERR invalid password'));
          } else {
            authed = true;
            socket.write(simpleFrame('OK'));
          }
        } else if (command === 'SUBSCRIBE') {
          if (!authed) {
            socket.write(errorFrame('NOAUTH'));
            continue;
          }
          state.subscriptions += 1;
          socket.write(subscribeFrame(args[0] ?? 'usage', 1));
          handlers.onSubscribe?.({ socket, count: state.subscriptions });
        } else {
          socket.write(errorFrame(`ERR unknown command '${command}'`));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of state.sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function waitFor(predicate, { timeout = 4000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the expected state');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function stubStore() {
  const calls = { ingested: [], gaps: [], closedGaps: [] };
  return {
    calls,
    store: {
      ingest: (record) => calls.ingested.push(record),
      recordGap: (gap) => calls.gaps.push(gap),
      closeOpenGap: (endedAt) => calls.closedGaps.push(endedAt),
    },
  };
}

const usageRecord = JSON.stringify({
  timestamp: '2026-09-10T18:00:00Z',
  latency_ms: 1200,
  auth_index: 'auth-1',
  tokens: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  failed: false,
  provider: 'codex',
  model: 'gpt-5.4',
  alias: 'client-gpt',
  api_key: 'sk-secret-value',
  request_id: 'req-1',
});

test('subscribes to broadcast usage and stores records', async (t) => {
  const server = await startFakeServer({
    onSubscribe: ({ socket }) => socket.write(messageFrame('usage', usageRecord)),
  });
  t.after(() => server.close());
  const store = createStore({ path: ':memory:' });
  t.after(() => store.close());

  const statuses = [];
  const collector = startCollector({
    url: `redis://127.0.0.1:${server.port}`,
    password: 'management-key',
    store,
    onStatus: (status) => statuses.push(status),
  });
  t.after(() => collector.stop());

  await waitFor(() => store.snapshot('today').recent.length === 1);
  assert.deepEqual(server.state.commands, [
    ['AUTH', 'management-key'],
    ['SUBSCRIBE', 'usage'],
  ]);
  assert.equal(statuses.at(-1).state, 'collecting');
  assert.equal(statuses.at(-1).lastEventAt !== null, true);

  const [row] = store.snapshot('today').recent;
  assert.equal(row.provider, 'codex');
  assert.equal(row.tokens, 30);
  assert.equal(row.requestId, 'req-1');
  assert.equal(Object.values(row).includes('sk-secret-value'), false);
});

test('stops after an authentication failure instead of retrying', async (t) => {
  const server = await startFakeServer({ rejectAuth: true });
  t.after(() => server.close());
  const { calls, store } = stubStore();

  const statuses = [];
  const collector = startCollector({
    url: `redis://127.0.0.1:${server.port}`,
    password: 'wrong-key',
    store,
    onStatus: (status) => statuses.push(status),
  });
  t.after(() => collector.stop());

  await waitFor(() => statuses.some((status) => status.state === 'error'));
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.equal(server.state.connections, 1);
  assert.deepEqual(server.state.commands, [['AUTH', 'wrong-key']]);
  const failure = statuses.find((status) => status.state === 'error');
  assert.equal(failure.message.includes('wrong-key'), false);
  assert.equal(calls.gaps.length, 1);
  assert.equal(calls.gaps[0].endedAt, null);
});

test('reconnects after a drop and closes the collection gap', async (t) => {
  const server = await startFakeServer({
    onSubscribe: ({ socket, count }) => {
      if (count === 1) setTimeout(() => socket.destroy(), 30);
    },
  });
  t.after(() => server.close());
  const { calls, store } = stubStore();

  const statuses = [];
  const collector = startCollector({
    url: `redis://127.0.0.1:${server.port}`,
    password: 'management-key',
    store,
    onStatus: (status) => statuses.push(status),
  });
  t.after(() => collector.stop());

  await waitFor(() => server.state.subscriptions === 2);
  await waitFor(() => statuses.at(-1).state === 'collecting');
  assert.equal(server.state.connections, 2);
  assert.equal(calls.gaps.length, 2, 'initial connection and disconnected gaps are recorded');
  assert.equal(calls.gaps[0].endedAt, null);
  assert.equal(calls.closedGaps.length, 2);
});

test('reports unconfigured setups without connecting', async (t) => {
  const statuses = [];
  const collector = startCollector({
    url: '',
    password: 'management-key',
    store: stubStore().store,
    onStatus: (status) => statuses.push(status),
  });
  t.after(() => collector.stop());
  assert.equal(statuses.at(-1).state, 'unconfigured');

  const withoutPassword = [];
  const other = startCollector({
    url: 'redis://127.0.0.1:1',
    password: '',
    store: stubStore().store,
    onStatus: (status) => withoutPassword.push(status),
  });
  t.after(() => other.stop());
  assert.equal(withoutPassword.at(-1).state, 'unconfigured');
  assert.match(withoutPassword.at(-1).message, /password/i);
});
