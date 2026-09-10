# Quota contract

Source review performed 2026-09-10. All fixtures are synthetic. The live management probe returned 401, so neither real provider responses nor sustainable five-second polling were verified.

## Transport and identity

The management HTTP base is normalized once. `GET /auth-files` returns `files`; included accounts use `provider` and stable `auth_index`. The checked-in management reference explicitly calls `auth_index` a stable runtime identifier. `CODEX_ACCOUNT_WEIGHTS` maps that exact field to `5` or `20`. Names, email addresses, plan labels, and array positions do not choose weights. Reconfirm the mapping if an account is removed/reimported and its identifier changes.

Quota calls use `POST /api-call` with `{auth_index, method, url, header, data?}`. Header values contain the literal `$TOKEN$` placeholder, which the proxy resolves. The result's `status_code` is the upstream status; the outer HTTP status belongs to management. The browser cannot invoke this forwarding endpoint.

| Provider | Upstream request | Normalized readings |
| --- | --- | --- |
| Codex | GET `https://chatgpt.com/backend-api/wham/usage`; Bearer `$TOKEN$`, JSON content type, reference Codex user agent; `chatgpt-account-id` when exposed in account metadata | `rate_limit.primary_window` / `secondary_window`: remaining = 100 − `used_percent`, exact `limit_window_seconds`, `reset_at` Unix seconds or `reset_after_seconds`. Code-review and named additional limits retain separate scopes. |
| Claude | GET `https://api.anthropic.com/api/oauth/usage`; Bearer `$TOKEN$`, `anthropic-beta: oauth-2025-04-20` | `five_hour`, `seven_day` and explicit OAuth-app/Opus/Sonnet/Cowork weekly windows: remaining = 100 − `utilization`, `resets_at` ISO instant. |
| Antigravity | POST `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`; reference Antigravity headers, `data` string containing `{project: projectId}` | Explicit Gemini `groups[].buckets[]`: `remainingFraction`, `window`, `bucketId`, `resetTime` (documented snake-case aliases also accepted). `models[modelId].quotaInfo` fallback retains each Gemini model's remaining fraction and provider reset window separately. |

Antigravity `project_id` must be available in the account's top-level, metadata, or attributes fields. Missing project metadata is reported; this app does not download raw authentication files, guess a project ID, or silently fall back through multiple endpoints. The public reference also knows `fetchAvailableModels`; support for a models-shaped response does not claim this endpoint was called or validated here. Non-Gemini quota groups are excluded. Model reset data does not imply a five-hour or weekly allowance. Missing required windows remain Unknown with an explanatory message. Equal Antigravity weights apply only within the same reported model/group and window.

## Aggregation and failures

- Remaining quota is `sum(weight × remainingPercent) / sum(weight)` for comparable, observed, mapped accounts. x5 at 80% plus x20 at 20% yields **32%**. Token/request totals are never weighted.
- Never-observed windows and unmapped Codex accounts do not enter the denominator. Coverage remains visible. Invalid percentages/fractions are rejected rather than clipped to zero/full.
- Differing Codex window durations and model scopes have different IDs. Explicit Antigravity models are kept separate. Distinct groups are not reduced to a synthetic most-constrained model.
- An exhausted account has an observed matching window at 0%; the provider summary counts its identifier once even if multiple windows are exhausted. Unmapped/unknown accounts do not count as exhausted.
- A failed or omitted window retains its last success, marked stale. Aggregate observation time is the oldest contributing reading. Readings also age into stale after two refresh intervals. Resets show the earliest **next account reset** and the latest reset; they do not promise a simultaneous pool reset.
- One backend schedule runs every five seconds with a shared in-flight promise and 10-second request timeout. Slow cycles skip overlapping ticks. There is no extra poller per browser.
- Outer management 401/403 stops automatic polling until service restart. Upstream account 401/403 pauses that account until restart. HTTP or envelope 429 honors `Retry-After` (seconds or HTTP date), with a 60-second fallback, and stops remaining requests in that cycle. Values remain stale during backoff.
- Snapshots omit account metadata, IDs, credentials, and raw upstream error bodies. Transport exceptions become fixed diagnostic messages. Quota cache is in memory: after backend restart readings start Unknown until successful refresh; request history persists independently.

## Sources

- [Checked-in management API reference](help-router-for-me-management-api.md), account-list and authenticated-upstream-call sections.
- [CPAMP provider requests](https://github.com/seakee/CPA-Manager-Plus/blob/main/apps/web/src/utils/quota/providerRequests.ts).
- [CPAMP quota constants](https://github.com/seakee/CPA-Manager-Plus/blob/main/apps/web/src/utils/quota/constants.ts).
- [CPAMP Antigravity builders](https://github.com/seakee/CPA-Manager-Plus/blob/main/apps/web/src/utils/quota/builders.ts).
- [CPAMP Codex window scopes](https://github.com/seakee/CPA-Manager-Plus/blob/main/apps/web/src/utils/quota/codexQuota.ts).

These public sources guide contract compatibility; CPAMP is not a runtime dependency. The grouped Gemini five-hour/weekly schema is source-backed but not a verified response from this installation.
