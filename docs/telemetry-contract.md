# Telemetry and persistence contract

The collector connects directly to a `redis://` or `rediss://` CLIProxyAPI listener, authenticates with `AUTH <management key>`, then sends `SUBSCRIBE usage`. It implements the small RESP2 subset itself. It never sends destructive queue reads, `HELLO`, `INFO`, `SELECT`, or client metadata. TLS uses normal certificate validation and DNS server-name indication.

The collector consumes broadcast `message` frames on channel `usage`, parsing each payload as one JSON event. Non-event control records and excluded providers are ignored. Bounded framing supports fragmented UTF-8/bulk/array replies, rejects malformed lengths/nesting, and caps buffered input at 1 MiB. Connection/handshake timeout is 10 seconds. Reconnect delays grow from one to 30 seconds; authentication/subscription rejection stops automatic retries. Socket errors and upstream replies are never copied into logs or browser diagnostics.

## Allowed persisted event fields

| Source | Stored meaning |
| --- | --- |
| `timestamp` (RFC3339 with timezone or epoch milliseconds) | UTC instant |
| `provider` | Only `antigravity`, `claude`, `codex`, case normalized |
| `auth_index` | Account reference for correlation |
| `model`, fallback `alias` | Model label |
| `request_id` | Correlation identifier, deliberately not unique |
| `failed` | Completed request outcome |
| `latency_ms` | Duration when supplied |
| `tokens.total_tokens` | Actual total, never reconstructed by summing overlapping categories |
| `tokens.input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens` | Available category counts, stored separately |

Unused raw fields—including `api_key`, source/email, endpoint, authentication metadata, and response headers—are discarded before persistence. The app does not log raw telemetry. Missing token values stay null in feed records. Provider totals sum the reported values; cached/reasoning categories are never added again to the source total. Two attempts with the same request ID remain separate records. xAI is excluded from storage, totals, and feed. Antigravity Claude-model requests remain included.

SQLite uses a persistent tracking-start record, timestamp indexes, WAL for disk-backed databases, a bounded newest-first feed (30 rows), and at most 50 recent gap records in responses. Startup and hourly cleanup remove records older than 60 × 24 hours; completed old gap records are cleaned up too. Browser Today/Week/Month reports use local midnight, Monday, or the first of the month in `America/Chicago`, independently of server timezone. Tests cover both 2026 US daylight-saving changes.

Connection and persistence failures open known gaps; successful subscription/recovery closes them. Graceful collector stop leaves a gap open across downtime. A durable service heartbeat every five seconds makes a restarted process conservatively report downtime even after an abrupt exit. Pub/sub provides no replay and this app does not backfill or import history. The heartbeat gives an approximate gap start, not proof that every request before it was delivered.

## Evidence

- [Approved subscription ADR](adr/0001-single-usage-collector.md).
- [Checked-in API telemetry example](help-router-for-me-management-api.md), usage-queue response fields. Its HTTP queue is documented only as payload evidence; this app never consumes it.
- [Public CPAMP collector](https://github.com/seakee/CPA-Manager-Plus/blob/main/apps/manager-server/internal/collector/collector.go) uses subscription messages as individual raw events and recognizes non-event refresh-control payloads.
- [Redis usage documentation](https://help.router-for-me/management/redis-usage-queue.html) was reviewed during the approved planning session. A fresh Firecrawl fetch in this session failed DNS resolution, so the current site was not revalidated.

The fake RESP tests verify compatibility with the documented command subset. Direct live listener access and healthy concurrent CPAMP delivery remain deployment-side checks.
