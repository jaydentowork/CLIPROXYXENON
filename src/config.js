import { resolve } from 'node:path';
import { parseApiKeyAliases } from './callers.js';

export function managementBase(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error('CLIPROXYAPI_BASE_URL must be an HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('CLIPROXYAPI_BASE_URL must be HTTP(S), without embedded credentials, query, or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/(?:\/v0\/management)+$/, '') + '/v0/management';
  return url.href.replace(/\/$/, '');
}

function parseOpenCodeApiKeys(value) {
  if (!value) return [];
  return [...new Set(String(value).split(',').map(key => key.trim()).filter(Boolean))];
}

export function readConfig(env = process.env, argv = process.argv) {
  const demo = argv.includes('--demo');
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  // The demo cannot contact upstream or open the live database, even with .env loaded.
  if (demo) return { demo, host: env.HOST || '127.0.0.1', port, apiKeyAliases: [] };
  let codexWeights;
  try { codexWeights = JSON.parse(env.CODEX_ACCOUNT_WEIGHTS || '{}'); } catch { throw new Error('CODEX_ACCOUNT_WEIGHTS must be a JSON object.'); }
  if (!codexWeights || Array.isArray(codexWeights) || typeof codexWeights !== 'object' ||
      Object.values(codexWeights).some(weight => weight !== 5 && weight !== 20)) {
    throw new Error('CODEX_ACCOUNT_WEIGHTS must map stable account identifiers to 5 or 20.');
  }
  const respUrl = env.CLIPROXYAPI_RESP_URL || null;
  if (respUrl) {
    let url;
    try { url = new URL(respUrl); } catch { throw new Error('CLIPROXYAPI_RESP_URL must be a redis:// or rediss:// URL.'); }
    if (!['redis:', 'rediss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
      throw new Error('CLIPROXYAPI_RESP_URL must use redis:// or rediss:// without credentials or a database path.');
    }
  }
  return {
    demo, host: env.HOST || '127.0.0.1', port,
    baseUrl: managementBase(env.CLIPROXYAPI_BASE_URL),
    managementKey: env.MANAGEMENT_KEY || '',
    respUrl, respPassword: env.CLIPROXYAPI_RESP_PASSWORD || env.MANAGEMENT_KEY || '',
    codexWeights, dataPath: resolve(env.DATA_PATH || 'data/dashboard.sqlite'),
    opencodeApiKeys: parseOpenCodeApiKeys(env.OPENCODE_APIKEY),
    apiKeyAliases: parseApiKeyAliases(env.API_KEY_ALIASES),
  };
}
