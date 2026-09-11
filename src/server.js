import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readConfig } from './config.js';
import { demoSnapshot } from './demo.js';
import { loadPricingCatalog } from './pricing.js';

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
// Dev-only allowance so impeccable live mode can load. Guarded by NODE_ENV.
const liveDev = process.env.NODE_ENV === 'development';
const liveSrc = liveDev ? ' http://localhost:8400' : '';
const liveStyle = liveDev ? " 'unsafe-inline'" : '';
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': `default-src 'self'; script-src 'self'${liveSrc}; style-src 'self'${liveStyle}; connect-src 'self'${liveSrc}; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`,
  'Cache-Control': 'no-store',
};

export async function startApp(config = readConfig()) {
  let store, quotaService, collector, cleanupTimer;
  let collectorStatus = { state: 'unconfigured', since: new Date().toISOString(), lastEventAt: null,
    message: 'Configure the direct RESP listener to collect request history.' };
  if (!config.demo) {
    const [{ createStore }, { createQuotaService }, { startCollector }] = await Promise.all([
      import('./storage.js'), import('./quota.js'), import('./collector.js'),
    ]);
    store = createStore({ path: config.dataPath, apiKeyAliases: config.apiKeyAliases });
    quotaService = createQuotaService({
      baseUrl: config.baseUrl,
      managementKey: config.managementKey,
      codexWeights: config.codexWeights,
      opencodeApiKeys: config.opencodeApiKeys,
    });
    if (config.respUrl) collector = startCollector({ url: config.respUrl, password: config.respPassword, store,
      onStatus: status => { collectorStatus = status; } });
    quotaService.start();
    cleanupTimer = setInterval(() => {
      try { store.cleanup(); } catch { collectorStatus = { ...collectorStatus, state: 'error', message: 'History cleanup failed; check persistent storage.' }; }
    }, 3600000);
    cleanupTimer.unref();
  }
  const server = createServer(async (request, response) => {
    const send = (status, body, contentType = 'application/json; charset=utf-8') => {
      response.writeHead(status, { ...securityHeaders, 'Content-Type': contentType });
      response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (request.method !== 'GET') return send(405, { error: 'Only GET is supported.' });
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { return send(400, { error: 'Invalid URL.' }); }
    try {
      if (url.pathname === '/api/dashboard') {
        const period = url.searchParams.get('period') || 'today';
        if (!['today', 'week', 'month'].includes(period)) return send(400, { error: 'period must be today, week, or month.' });
        const caller = url.searchParams.get('caller');
        if (caller !== null && !/^[A-Za-z0-9_-]{1,32}$/.test(caller)) return send(400, { error: 'caller must be a caller id from the dashboard payload.' });
        const data = config.demo ? demoSnapshot(period, Date.now(), caller) : {
          generatedAt: new Date().toISOString(), period, timezone: 'America/Chicago',
          ...store.snapshot(period, caller), quota: quotaService.snapshot(), collector: collectorStatus, demo: false,
        };
        return send(200, data);
      }
      if (url.pathname === '/healthz') return send(200, {
        status: 'ok', demo: config.demo, collector: config.demo ? 'simulated' : collectorStatus.state,
      });
      const asset = staticFiles[url.pathname];
      if (!asset) return send(404, { error: 'Not found.' });
      const data = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
      send(200, data, asset[1]);
    } catch {
      send(503, { error: 'Dashboard temporarily unavailable. Last displayed data may be stale.' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const close = async () => {
    clearInterval(cleanupTimer);
    collector?.stop();
    quotaService?.stop();
    await new Promise(resolveClose => server.close(resolveClose));
    store?.close();
  };
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolveListen);
    });
  } catch (error) { await close(); throw error; }
  return { server, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = readConfig();
    if (!config.demo) {
      const models = await loadPricingCatalog();
      console.log(models ? 'Loaded OpenRouter prices for ' + models + ' models.'
        : 'OpenRouter pricing unavailable; using built-in fallback prices.');
    }
    const app = await startApp(config);
    console.log(`XENEON EDGE ${config.demo ? 'simulated preview' : 'dashboard'} listening on port ${app.server.address().port}.`);
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      app.close().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    console.error(error.code === 'EADDRINUSE'
      ? `Dashboard startup failed: port ${error.port} is already in use. Stop the existing server before starting another instance.`
      : 'Dashboard startup failed. Check configuration, port availability, and persistent storage permissions.');
    process.exitCode = 1;
  }
}
