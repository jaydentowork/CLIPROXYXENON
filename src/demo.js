import { estimateCost } from './pricing.js';

const providers = ['antigravity', 'claude', 'codex'];
const feedProviders = [...providers, 'opencode', 'mimo'];
const feedModels = ['gemini-2.5-pro', 'claude-sonnet-4-5', 'gpt-5-codex', 'claude-sonnet-4-5', 'mimo-v2.5-pro'];
const trackingSince = new Date(Date.now() - 3 * 86400000).toISOString();

const DEMO_CALLERS = [{ id: 'demo-desk', alias: 'Desk' }, { id: 'demo-laptop', alias: 'Laptop' }, { id: 'demo-agents', alias: 'Agents' }];

export function demoSnapshot(period, now = Date.now(), caller = null) {
  const selected = typeof caller === 'string' && caller ? caller : null;
  const filter = DEMO_CALLERS.find(entry => entry.id === caller) ?? null;
  const share = selected === null ? 1 : { 'demo-desk': 0.55, 'demo-laptop': 0.3, 'demo-agents': 0.15 }[filter?.id] ?? 0;
  const iso = ms => new Date(ms).toISOString();
  const factor = { today: 1, week: 4, month: 13 }[period];
  const quota = {};
  const totals = {};
  for (const [index, provider] of providers.entries()) {
    const accounts = [8, 1, 2][index];
    const tokens = Math.round([4265800, 1387200, 2940600][index] * factor * share);
    const inputTokens = Math.round(tokens * [0.82, 0.76, 0.85][index]);
    totals[provider] = { requests: Math.round([328, 92, 214][index] * factor * share), tokens,
      inputTokens, outputTokens: tokens - inputTokens,
      cachedTokens: Math.round(inputTokens * [0.61, 0.44, 0.73][index]),
      reasoningTokens: Math.round(tokens * [0, 0.05, 0.12][index]),
      costUsd: estimateCost({ model: ['gemini-2.5-pro', 'claude-sonnet-4-5', 'gpt-5-codex'][index], inputTokens, outputTokens: tokens - inputTokens,
        cachedTokens: Math.round(inputTokens * [0.61, 0.44, 0.73][index]) }) };
    quota[provider] = { accounts, exhausted: [1, 0, 1][index], observedAccounts: accounts, message: null,
      windows: ['Five-hour', 'Weekly'].map((label, window) => ({
        id: `${provider}-${window}`, label, model: provider === 'antigravity' ? 'Gemini · simulated window' : null,
        remainingPercent: [[68, 42], [83, 56], [32, 24]][index][window],
        observedAccounts: accounts, totalAccounts: accounts, stale: false, observedAt: iso(now),
        nextResetAt: iso(now + (window ? 27 * 3600000 : 5400000)),
        latestResetAt: iso(now + (window ? 39 * 3600000 : 9000000)), message: null,
      })) };
  }

  // Usage-only providers report activity and estimated cost, with no quota model.
  for (const [provider, model, requests, tokenBase, cacheShare] of [
    ['opencode', 'claude-sonnet-4-5', 146, 2314800, 0.48],
    ['mimo', 'mimo-v2.5-pro', 284, 8642400, 0.70],
  ]) {
    const tokens = Math.round(tokenBase * factor * share);
    const inputTokens = Math.round(tokens * 0.82);
    const outputTokens = tokens - inputTokens;
    const cachedTokens = Math.round(inputTokens * cacheShare);
    totals[provider] = {
      requests: Math.round(requests * factor * share), tokens, inputTokens, outputTokens,
      cachedTokens, reasoningTokens: 0,
      costUsd: estimateCost({ model, inputTokens, outputTokens, cachedTokens }),
    };
  }

  return {
    generatedAt: iso(now), period, timezone: 'America/Chicago', trackingSince,
    totals, quota, gaps: [], demo: true, callers: DEMO_CALLERS, caller: selected,
    collector: { state: 'collecting', since: iso(now - 3600000), lastEventAt: iso(now - 1000), message: 'Simulated data' },
    recent: Array.from({ length: 30 }, (_, index) => {
      const who = DEMO_CALLERS[index % 3 === 0 ? 0 : index % 5 === 0 ? 2 : 1];
      const model = feedModels[index % feedModels.length];
      const tokens = 4800 + index * 213;
      const inputTokens = Math.round(tokens * 0.8);
      const outputTokens = tokens - inputTokens;
      const cachedTokens = Math.round(inputTokens * [0.61, 0.44, 0.73, 0.48, 0.70][index % feedProviders.length]);
      return {
        id: `demo-${Math.floor(now / 5000) - index}`, timestamp: iso(now - index * 12000),
        provider: feedProviders[index % feedProviders.length], account: 'Demo account', model,
        requestId: `demo-${index}`, outcome: index === 4 ? 'error' : 'success',
        durationMs: 1250 + index * 713, tokens, inputTokens, outputTokens, cachedTokens,
        costUsd: estimateCost({ model, inputTokens, outputTokens, cachedTokens }),
        caller: who.alias,
      };
    }).filter(row => selected === null || (filter && row.caller === filter.alias)),
  };
}
