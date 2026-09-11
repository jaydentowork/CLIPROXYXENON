// Maps caller API keys to display aliases so the browser can filter by
// caller without ever seeing a key. Only the alias and an opaque id leave
// this module; keys are compared, never stored or logged.

import { createHash } from 'node:crypto';

// Sanitized alias: printable, bounded, never a key look-alike.
function cleanAlias(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, 40) : null;
}

export function parseApiKeyAliases(value) {
  if (!value) return [];
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('API_KEY_ALIASES must be a JSON object mapping API keys to aliases.'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('API_KEY_ALIASES must be a JSON object mapping API keys to aliases.');
  }
  const seen = new Set();
  const entries = [];
  for (const [key, alias] of Object.entries(parsed)) {
    const label = cleanAlias(alias);
    if (!key.trim() || !label) throw new Error('API_KEY_ALIASES entries need a non-empty key and alias.');
    if (seen.has(label)) throw new Error(`API_KEY_ALIASES alias "${label}" is used twice.`);
    seen.add(label);
    entries.push({ key, alias: label });
  }
  return entries;
}

// The caller id stored with each event is a short hash of the key, not the
// key itself: a fixed-length opaque token that still lets rows be grouped.
export function callerId(key) {
  if (typeof key !== 'string' || !key) return null;
  return createHash('sha256').update(key).digest('base64url').slice(0, 16);
}

export function createCallerDirectory(entries = []) {
  const byKey = new Map(entries.map(({ key, alias }) => [key, { id: callerId(key), alias }]));
  const byId = new Map([...byKey.values()].map(caller => [caller.id, caller]));
  return {
    // Resolve the caller for one telemetry record; unknown keys still get an
    // opaque id so their traffic can be grouped as "other".
    resolve(rawKey) {
      if (typeof rawKey !== 'string' || !rawKey) return null;
      return byKey.get(rawKey)?.id ?? callerId(rawKey);
    },
    aliasFor(id) {
      return byId.get(id)?.alias ?? null;
    },
    isKnown(id) {
      return byId.has(id);
    },
    // What the browser is allowed to see: alias and opaque id only.
    list() {
      return [...byId.values()].map(({ id, alias }) => ({ id, alias }));
    },
  };
}