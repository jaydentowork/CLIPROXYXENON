# Runtime contract

Implementation coordination for this task; approved requirements remain in dashboard-brief.md.

## Module boundaries

- Configuration and HTTP: `src/config.js`, `src/server.js`, `src/demo.js`.
- Durable usage history and subscription: `src/storage.js`, `src/time.js`, `src/collector.js`.
- Provider quota: `src/quota.js`.
- Browser interface: `public/`; product and visual context: PRODUCT.md and DESIGN.md.

Use Node >=24.2, ESM, built-in modules, no runtime dependencies. Provider IDs: `antigravity`, `claude`, `codex`.

## Storage and collector

`src/storage.js`: export `createStore({path, now = () => Date.now()})`, returning `ingest(raw)` (validate/sanitize/filter telemetry), `snapshot(period)` returning `{trackingSince, totals, recent, gaps}`, `recordGap({startedAt, endedAt, reason})`, `cleanup()`, `close()`. `totals` is an object keyed by provider, each `{requests, tokens, inputTokens, outputTokens, cachedTokens, reasoningTokens, costUsd}`. Recent is newest first, at most 30, each `{id, timestamp, provider, account, model, requestId, outcome, durationMs, tokens, inputTokens, outputTokens, cachedTokens, costUsd}`. `costUsd` is an estimate from `src/pricing.js` list prices and is null for unpriced models; IDs are local unique IDs. Gaps use ISO timestamps. Source request IDs are correlation only, never unique. `src/collector.js`: export `startCollector({url, password, store, onStatus})` returning `{stop()}`. Status is `{state, since, lastEventAt, message}`; states collecting/disconnected/error/unconfigured. RESP URL is separate from HTTP URL. Use only AUTH and SUBSCRIBE usage; no destructive reads or generic Redis handshake. Sanitize all errors.

## Quota

`src/quota.js`: export `createQuotaService({baseUrl, managementKey, codexWeights, intervalMs = 30 * 60 * 1000, spacingMs = 500, fetchImpl = fetch, now = () => Date.now()})`, returning `{start(), stop(), snapshot()}`. Snapshot is an object keyed by provider with `{accounts, exhausted, observedAccounts, windows, message}`. A window is `{id, label, model, remainingPercent, observedAccounts, totalAccounts, stale, observedAt, nextResetAt, latestResetAt, message}`. Unknown remainingPercent is null. All times ISO or null. Never-observed excluded; stale retained. Codex weights keyed by stable identifier, never order. Expose missing mapping as Unknown and actionable message. Antigravity quota Gemini only; preserve actual windows and clearly report unavailable requested windows. No secrets or arbitrary account payloads in snapshot. Pollers only backend, no overlap, space upstream account calls, respect Retry-After per provider, stop automatic authentication retries on 401/403. Public helpers and additional focused files/tests within assigned area are allowed.

## HTTP and browser

The HTTP server combines local usage history, the shared quota cache, and collector state.

`GET /api/dashboard?period=today|week|month[&caller=<id>]`: `{generatedAt, period, timezone:'America/Chicago', trackingSince, totals, recent, gaps, quota, collector, demo, callers, caller}`. `callers` lists `{id, alias}` from `API_KEY_ALIASES`; `caller` echoes the applied filter id or null. Any supplied caller id is applied as a filter; an unmatched id returns empty usage. `GET /healthz`: sanitized service health. Browser polls every five seconds, guards period races, uses textContent for external text. Frontend owns `public/`, PRODUCT.md and DESIGN.md. Demo data must carry `demo:true` and visible simulated-data label. Default live mode never seeds history or quota.

All writers preserve existing files and .env, use rtk commands, fff search, graft once available. Owned source/tests must be checked with node --test. No live credential use by subagents: primary owns bounded live probes. No publishing, deployment, or nested agents.

## Usage-only providers

OpenCode and MiMo are included in stored activity, period totals, and the live feed.
The collector accepts normalized provider ids `opencode` and `mimo`. Neither
provider is added to quota polling. Their cards show Requests and Tokens above Input, Output, and Est. cost, with no quota.

MiMo USD rates per million tokens, supplied by the user on 2026-09-10:

| Model | Cached input | Uncached input | Output |
| --- | ---: | ---: | ---: |
| `mimo-v2.5-pro` | $0.0036 | $0.435 | $0.87 |
| `mimo-v2.5` (Flash) | $0.0028 | $0.14 | $0.28 |

Pricing matches these exact model ids, with optional vendor prefixes. Cached
input is removed from the regular input count before pricing. OpenCode uses the startup OpenRouter catalog and name matching. MiMo rates override catalog prices. Unsupported models remain unpriced.

The password field saves the raw API key in browser localStorage only and hashes it before the first request. Clearing removes the saved key. Quota remains provider-wide; this is not an authentication boundary. Pricing loads from the public OpenRouter model catalog during normal CLI startup, with an eight-second timeout and built-in fallback. Provider cost totals sum per-request estimates so context-length tiers are applied correctly. Claude native input is priced separately from cached reads.
