import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { startApp } from '../src/server.js';
import { readConfig } from '../src/config.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/contracts.json', import.meta.url), 'utf8'));
const bulk = text => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
const command = parts => `*${parts.length}\r\n${parts.map(bulk).join('')}`;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

test('actual app collects broadcast telemetry, serves weighted quotas, redacts secrets, and persists on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xeneon-integration-'));
  const path = join(directory, 'history.sqlite');
  const sockets = new Set();
  const commands = [];
  const management = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-management');
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/auth-files')) return res.end(JSON.stringify({ files: [
      { provider: 'codex', auth_index: 'fixture-5' }, { provider: 'codex', auth_index: 'fixture-20' },
    ] }));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.header.Authorization, 'Bearer $TOKEN$');
    const payload = structuredClone(fixture.codex);
    payload.rate_limit.primary_window.used_percent = body.auth_index === 'fixture-5' ? 20 : 80;
    res.end(JSON.stringify({ status_code: 200, body: JSON.stringify(payload) }));
  });
  const resp = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let pending = '';
    let stage = 0;
    socket.on('data', chunk => {
      pending += chunk;
      const expected = stage === 0 ? command(['AUTH', 'fixture-management']) : command(['SUBSCRIBE', 'usage']);
      if (pending.length < expected.length) return;
      assert.equal(pending, expected, 'only documented RESP commands are sent');
      commands.push(stage === 0 ? 'AUTH' : 'SUBSCRIBE');
      pending = '';
      if (stage++ === 0) return socket.write('+OK\r\n');
      socket.write(`*3\r\n${bulk('subscribe')}${bulk('usage')}:1\r\n`);
      const event = { ...fixture.telemetry, timestamp: new Date().toISOString() };
      socket.write(command(['message', 'usage', JSON.stringify(event)]));
      socket.write(command(['message', 'usage', JSON.stringify({ ...event, provider: 'xai' })]));
      socket.write(command(['message', 'usage', JSON.stringify({ ...event, failed: true })]));
    });
  });
  let app;
  try {
    await listen(management);
    await listen(resp);
    const config = readConfig({ DATA_PATH: path, PORT: '0',
      CLIPROXYAPI_BASE_URL: `http://127.0.0.1:${management.address().port}`,
      MANAGEMENT_KEY: 'fixture-management', CLIPROXYAPI_RESP_URL: `redis://127.0.0.1:${resp.address().port}`,
      CODEX_ACCOUNT_WEIGHTS: '{"fixture-5":5,"fixture-20":20}' }, []);
    app = await startApp(config);
    let snapshot;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      snapshot = await fetch(`http://127.0.0.1:${app.server.address().port}/api/dashboard`).then(r => r.json());
      if (snapshot.recent.length === 2 && snapshot.quota.codex.windows[0].remainingPercent === 32) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(snapshot.demo, false);
    assert.equal(snapshot.collector.state, 'collecting');
    assert.equal(snapshot.recent.length, 2);
    assert.equal(snapshot.totals.antigravity.tokens, 6000);
    assert.equal(snapshot.totals.antigravity.requests, 2);
    assert.equal(snapshot.quota.codex.windows[0].remainingPercent, 32);
    assert.equal(JSON.stringify(snapshot).includes(fixture.telemetry.api_key), false);
    assert.deepEqual(commands, ['AUTH', 'SUBSCRIBE']);
    const tracking = snapshot.trackingSince;
    await app.close();
    app = await startApp(readConfig({ DATA_PATH: path, PORT: '0' }, []));
    const restarted = await fetch(`http://127.0.0.1:${app.server.address().port}/api/dashboard`).then(r => r.json());
    assert.equal(restarted.trackingSince, tracking);
    assert.equal(restarted.recent.length, 2);
    assert.ok(restarted.gaps.some(gap => gap.endedAt === null));
    assert.equal(restarted.collector.state, 'unconfigured');
    await app.close();
    app = null;
    assert.equal((await readFile(path)).includes(Buffer.from(fixture.telemetry.api_key)), false);
  } finally {
    await app?.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(management), close(resp)]);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes('xeneon-integration-'));
    await rm(directory, { recursive: true, force: true });
  }
});
