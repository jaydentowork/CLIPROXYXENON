// Independent broadcast subscriber for CLIProxyAPI usage telemetry.
//
// The proxy exposes a deliberately small RESP surface: AUTH, LPOP, RPOP, and
// SUBSCRIBE usage. This collector only ever sends AUTH and SUBSCRIBE, so it can
// never pull records out of the FIFO queue another collector may be draining.

import net from 'node:net';
import tls from 'node:tls';

const CHANNEL = 'usage';
const MAX_MESSAGE_LENGTH = 200;
const MAX_BUFFER_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const DEFAULT_RESP_PORT = 6379;

function clean(text, secrets) {
  let message = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message.slice(0, MAX_MESSAGE_LENGTH);
}

function encodeCommand(args) {
  let text = `*${args.length}\r\n`;
  for (const arg of args) {
    text += `$${Buffer.byteLength(arg, 'utf8')}\r\n${arg}\r\n`;
  }
  return Buffer.from(text, 'utf8');
}

// Returns { value, offset } or null while the frame is still incomplete.
function parseFrame(buffer, start, depth = 0) {
  if (depth > 8) throw new Error('Invalid RESP nesting.');
  if (start >= buffer.length) return null;
  const type = String.fromCharCode(buffer[start]);
  const lineEnd = buffer.indexOf('\r\n', start + 1);
  if (lineEnd === -1) return null;
  const line = buffer.toString('utf8', start + 1, lineEnd);
  const next = lineEnd + 2;
  if (type === '+') return { value: { type: 'simple', value: line }, offset: next };
  if (type === '-') return { value: { type: 'error', value: line }, offset: next };
  if (type === ':') return { value: { type: 'integer', value: Number(line) }, offset: next };
  if (type === '$') {
    const length = Number(line);
    if (!Number.isInteger(length) || length < -1 || length > MAX_BUFFER_BYTES) throw new Error('Invalid bulk length.');
    if (length === -1) return { value: { type: 'bulk', value: null }, offset: next };
    if (buffer.length < next + length + 2) return null;
    if (buffer.toString('utf8', next + length, next + length + 2) !== '\r\n') throw new Error('Invalid bulk terminator.');
    return {
      value: { type: 'bulk', value: buffer.toString('utf8', next, next + length) },
      offset: next + length + 2,
    };
  }
  if (type === '*') {
    const count = Number(line);
    if (!Number.isInteger(count) || count < -1 || count > 1000) throw new Error('Invalid array length.');
    if (count === -1) return { value: { type: 'array', value: null }, offset: next };
    const items = [];
    let cursor = next;
    for (let index = 0; index < count; index += 1) {
      const parsed = parseFrame(buffer, cursor, depth + 1);
      if (!parsed) return null;
      items.push(parsed.value);
      cursor = parsed.offset;
    }
    return { value: { type: 'array', value: items }, offset: cursor };
  }
  throw new Error('Unsupported RESP frame.');
}

function parseTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return { error: 'Usage subscription URL is not configured.' };
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { error: 'Usage subscription URL is not a valid redis:// or rediss:// URL.' };
  }
  const secure = parsed.protocol === 'rediss:';
  if (!secure && parsed.protocol !== 'redis:') {
    return { error: 'Usage subscription URL must use redis:// or rediss://.' };
  }
  const port = parsed.port ? Number(parsed.port) : DEFAULT_RESP_PORT;
  if (!parsed.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return { error: 'Usage subscription URL must include a host and a valid port.' };
  }
  return { host: parsed.hostname.replace(/^\[|\]$/g, ''), port, secure };
}

export function startCollector({ url, password, store, onStatus } = {}) {
  const secret = typeof password === 'string' ? password : '';
  const secrets = [secret];
  const notify = typeof onStatus === 'function' ? onStatus : () => {};
  const target = parseTarget(url);

  let state = 'unconfigured';
  let stateSince = Date.now();
  let message = '';
  let lastEventAt = null;
  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let handshakeTimer = null;
  let buffer = Buffer.alloc(0);
  let awaiting = null;
  let attempt = 0;
  let authFailed = false;
  let openGap = false;
  let connectionError = '';
  let generation = 0;

  function status() {
    return { state, since: new Date(stateSince).toISOString(), lastEventAt, message };
  }

  function publish() {
    try {
      notify(status());
    } catch {
      // A status consumer that throws must not take the collector down.
    }
  }

  function setState(next, nextMessage = '') {
    state = next;
    stateSince = Date.now();
    message = clean(nextMessage, secrets);
    publish();
  }

  function setMessage(nextMessage) {
    const next = clean(nextMessage, secrets);
    if (next === message) return;
    message = next;
    publish();
  }

  function openCollectionGap(reason) {
    if (openGap) return;
    openGap = true;
    try {
      store?.recordGap?.({ startedAt: new Date().toISOString(), endedAt: null, reason });
    } catch {
      // Gap bookkeeping is best effort; collection continues either way.
    }
  }

  function closeCollectionGap() {
    openGap = false;
    try {
      store?.closeOpenGap?.(new Date().toISOString());
    } catch {
      // See openCollectionGap.
    }
  }

  function clearHandshakeTimer() {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  }

  function send(args) {
    if (!socket || socket.destroyed) return;
    socket.write(encodeCommand(args));
  }

  function handleUsageMessage(payloadText) {
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      setMessage('Usage subscription received a malformed record.');
      return;
    }
    try {
      const stored = store?.ingest?.(payload);
      if (!stored) return;
      lastEventAt = new Date().toISOString();
      if (state === 'error') {
        closeCollectionGap();
        setState('collecting');
      }
    } catch {
      openCollectionGap('usage record could not be persisted');
      setState('error', 'Could not store a usage record; check persistent storage.');
      return;
    }
    publish();
  }

  function dispatch(value) {
    if (value.type === 'error') {
      if (awaiting === 'auth') {
        authFailed = true;
        openCollectionGap('usage subscription authentication failed');
        setState('error', 'Usage subscription authentication failed; automatic retries stopped.');
      } else if (awaiting === 'subscribe') {
        authFailed = true;
        openCollectionGap('usage subscription rejected');
        setState('error', 'Usage subscription was rejected; automatic retries stopped.');
      } else {
        setMessage('Usage subscription reported an error.');
      }
      socket?.destroy();
      return;
    }
    if (awaiting === 'auth') {
      if (value.type !== 'simple' || value.value !== 'OK') {
        authFailed = true;
        openCollectionGap('usage subscription authentication failed');
        setState('error', 'Usage subscription authentication failed: unexpected AUTH reply.');
        socket?.destroy();
        return;
      }
      awaiting = 'subscribe';
      send(['SUBSCRIBE', CHANNEL]);
      return;
    }
    if (awaiting === 'subscribe') {
      const frame = value.type === 'array' ? value.value : null;
      if (!frame || frame[0]?.type !== 'bulk' || frame[0].value !== 'subscribe' || frame[1]?.value !== CHANNEL) return;
      awaiting = null;
      clearHandshakeTimer();
      attempt = 0;
      closeCollectionGap();
      setState('collecting');
      return;
    }
    const frame = value.type === 'array' ? value.value : null;
    if (!frame || frame[0]?.type !== 'bulk') return;
    if (frame[0].value === 'message' && frame[1]?.value === CHANNEL && frame[2]?.type === 'bulk' && typeof frame[2].value === 'string') {
      handleUsageMessage(frame[2].value);
    }
  }

  function handleData(frameGeneration, chunk) {
    if (frameGeneration !== generation) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    if (buffer.length > MAX_BUFFER_BYTES) {
      connectionError = 'Usage subscription sent an oversized frame.';
      socket?.destroy();
      return;
    }
    for (;;) {
      let parsed;
      try { parsed = parseFrame(buffer, 0); } catch {
        connectionError = 'Usage subscription sent an invalid RESP frame.';
        socket?.destroy();
        break;
      }
      if (!parsed) break;
      buffer = buffer.subarray(parsed.offset);
      dispatch(parsed.value);
    }
  }

  function scheduleReconnect() {
    if (stopped || authFailed) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function handleClose(frameGeneration) {
    if (frameGeneration !== generation || stopped) return;
    socket = null;
    buffer = Buffer.alloc(0);
    awaiting = null;
    clearHandshakeTimer();
    if (authFailed) return;
    openCollectionGap('usage subscription disconnected');
    setState('disconnected', connectionError || 'Usage subscription disconnected.');
    connectionError = '';
    scheduleReconnect();
  }

  function connect() {
    if (stopped) return;
    generation += 1;
    const frameGeneration = generation;
    buffer = Buffer.alloc(0);
    awaiting = null;
    connectionError = '';
    const options = { host: target.host, port: target.port,
      ...(target.secure && !net.isIP(target.host) ? { servername: target.host } : {}) };
    handshakeTimer = setTimeout(() => {
      connectionError = 'Usage subscription connection or handshake timed out.';
      socket?.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    const onReady = () => {
      if (frameGeneration !== generation || stopped) return;
      if (secret) {
        awaiting = 'auth';
        send(['AUTH', secret]);
      } else {
        awaiting = 'subscribe';
        send(['SUBSCRIBE', CHANNEL]);
      }
    };
    const connection = target.secure ? tls.connect(options, onReady) : net.connect(options, onReady);
    connection.setNoDelay(true);
    connection.on('data', (chunk) => handleData(frameGeneration, chunk));
    connection.on('error', () => {
      if (frameGeneration !== generation) return;
      connectionError = 'Usage subscription connection failed; check listener and TLS configuration.';
    });
    connection.on('close', () => handleClose(frameGeneration));
    socket = connection;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearHandshakeTimer();
    openCollectionGap('usage collector stopped');
    const connection = socket;
    socket = null;
    if (connection) {
      connection.removeAllListeners();
      connection.destroy();
    }
  }

  if (target.error) {
    setState('unconfigured', target.error);
  } else if (!secret) {
    setState('unconfigured', 'Usage subscription password is not configured.');
  } else {
    setState('disconnected', 'Connecting to the usage subscription.');
    openCollectionGap('usage subscription connecting');
    connect();
  }

  return { stop };
}
