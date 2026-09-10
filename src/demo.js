const providers = ['antigravity', 'claude', 'codex'];
const trackingSince = new Date(Date.now() - 3 * 86400000).toISOString();

export function demoSnapshot(period, now = Date.now()) {
  const iso = ms => new Date(ms).toISOString();
  const factor = { today: 1, week: 4, month: 13 }[period];
  const quota = {};
  const totals = {};
  for (const [index, provider] of providers.entries()) {
    const accounts = [8, 1, 2][index];
    totals[provider] = { requests: [328, 92, 214][index] * factor, tokens: [4265800, 1387200, 2940600][index] * factor,
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
    quota[provider] = { accounts, exhausted: [1, 0, 1][index], observedAccounts: accounts, message: null,
      windows: ['Five-hour', 'Weekly'].map((label, window) => ({
        id: `${provider}-${window}`, label, model: provider === 'antigravity' ? 'Gemini · simulated window' : null,
        remainingPercent: [[68, 42], [83, 56], [32, 24]][index][window],
        observedAccounts: accounts, totalAccounts: accounts, stale: false, observedAt: iso(now),
        nextResetAt: iso(now + (window ? 27 * 3600000 : 5400000)),
        latestResetAt: iso(now + (window ? 39 * 3600000 : 9000000)), message: null,
      })) };
  }
  return {
    generatedAt: iso(now), period, timezone: 'America/Chicago', trackingSince,
    totals, quota, gaps: [], demo: true,
    collector: { state: 'collecting', since: iso(now - 3600000), lastEventAt: iso(now - 1000), message: 'Simulated data' },
    recent: Array.from({ length: 30 }, (_, index) => ({
      id: `demo-${Math.floor(now / 5000) - index}`, timestamp: iso(now - index * 12000),
      provider: providers[index % 3], account: 'Demo account',
      model: ['gemini-2.5-pro', 'claude-sonnet-4-5', 'gpt-5-codex'][index % 3],
      requestId: `demo-${index}`, outcome: index === 4 ? 'error' : 'success',
      durationMs: 1250 + index * 713, tokens: 4800 + index * 213,
    })),
  };
}
