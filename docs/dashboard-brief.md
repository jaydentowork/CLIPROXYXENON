# XENEON EDGE dashboard brief

## Confirmed requirements

- Personal, at-a-glance monitoring display for a 2560 × 720 CORSAIR XENEON EDGE.
- Use a dark theme, with readable high-contrast text and touch-friendly controls appropriate to the EDGE display.
- At 2560 × 720, place the three included provider summaries across the left two-thirds and the live request feed in the right third, keeping these areas visible together without page scrolling.
- Display quota and request activity; no account or proxy management controls.
- Group information by currently configured, included providers.
- Include Antigravity, Claude, and Codex. Exclude xAI from the display and its totals.
- Combine usage across accounts within each provider.
- Show capacity-weighted remaining quota per provider, calculated separately for matching models and quota windows: sum(account weight × remaining percentage) / sum(account weights).
- Display separate capacity-weighted bars for each quota window within a provider group; do not hide other windows behind a single most-constrained summary.
- The user reports one Codex x5 account and one x20 account. Their quota weights are 5 and 20 (a 1:4 ratio), rather than equal weights.
- The user confirms all eight Antigravity accounts have equal allowances; use equal account weights for matching quota windows.
- Antigravity quota bars show Gemini only, with separate five-hour and weekly windows; availability still needs verification from provider data. This restriction does not apply to Codex or the separate Claude provider.
- Include all Antigravity request activity and token usage, including Claude-model requests routed through Antigravity. Gemini-only filtering applies to its quota bars, not activity or usage totals.
- Usage counts are summed as recorded; quota capacity weights do not multiply actual usage counts.
- Show an exhausted-account count beside each provider's weighted quota summary (for example, "1 of 2 accounts exhausted").
- Refresh dashboard data every 5 seconds. Feasibility of fetching fresh provider quota at that frequency remains to be checked against provider behavior and rate limits.
- On a failed quota refresh, retain the last successful value with a visible stale label and timestamp. Show Unknown if no successful reading exists; missing data must not appear as zero or full quota.
- Token usage defaults to Today, with Week and Month selections accessible through large touch controls on the touchscreen.
- Week uses a calendar week beginning Monday at 00:00 in America/Chicago, rather than a rolling seven-day period.
- Month uses the current calendar month beginning on the first at 00:00 in America/Chicago, rather than a rolling 30-day period.
- Reporting uses US Central Time (Texas), represented by `America/Chicago`, including automatic CST/CDT daylight-saving transitions. Daily boundaries follow local midnight, independently of the server timezone.
- The live request feed shows completed requests on the next five-second refresh, independently of the selected token-usage period. In-flight request visibility is not required.
- Use one backend collector within this app to save history and supply its browser clients. Use an independent broadcast subscription alongside CPAMP, subject to deployment connectivity verification; browser clients do not consume the upstream queue themselves. See [ADR 0001](adr/0001-single-usage-collector.md).
- Build a standalone app with its own collector and saved usage history, without depending on the existing dashboard or its database.
- The existing dashboard must continue running and receiving usage data alongside this app. Collection must deliver complete records to both; do not disable its collection as a shortcut.
- Run this app's backend and usage collector on the remote server hosting CLIProxyAPI, collecting history continuously. The EDGE touchscreen accesses the standalone dashboard through a browser.
- Deliver the app through a GitHub repository with setup instructions. Direct deployment to the remote server is not required for the current deliverable. Keep credentials out of the repository.
- Rely on the user's existing access layer; do not add an app-specific login. Keep upstream management credentials on the backend.
- Start usage history fresh when collection begins after deployment; do not import CPAMP history. Display a tracking-start timestamp so initially partial reporting periods are identifiable.
- Retain collected request history for 60 days and automatically delete older records.

## Verified setup

- The management account-list request succeeded after the user reset an IP ban.
- Account counts at discovery: Antigravity 8, Claude 1, Codex 2, xAI 1.
- No accounts were marked disabled or unavailable in that response.
- Provider quota payloads have not yet been inspected.
- The existing dashboard is CPAMP (CPA Manager Plus). Its authenticated `/status` endpoint returned HTTP 200, `mode: auto`, and `transport: subscribe` on 2026-09-10. Its installed version has not been verified.
- Redis usage-queue documentation describes `SUBSCRIBE usage`: new records are broadcast to all connected subscribers, but are not added to the FIFO polling queue while any subscriber is connected. This is a possible independent-app integration only if the existing dashboard also uses a compatible subscription method. Live-server support and network access have not been verified.
- CPAMP's current public collector source supports explicit `subscribe` mode. Its `auto` mode tries subscriptions first, then HTTP collection if the initial subscription is unavailable; a successful subscription reports `transport: subscribe`. Public source: https://github.com/seakee/CPA-Manager-Plus/blob/main/apps/manager-server/internal/collector/collector.go (inspected 2026-09-10). This does not establish the user's deployed transport.
- CPAMP's current dashboard collector card shows configured `mode`, not active `transport`. Its authenticated, read-only `GET /status` endpoint uses CPAMP panel authentication, which must not be assumed identical to the proxy management key. The user supplied access for the status check; the credential is not stored in project files.
- At the live check, CPAMP reported collector state `error`: upstream authentication was blocked by an IP ban, with about 11 minutes remaining. The reported subscription transport is evidence of its collection method, not proof of a healthy current connection. No CPAMP configuration or collection behavior was changed.
- A subsequent attempt to inspect a representative quota payload stopped at a management `/auth-files` HTTP 403. No upstream provider quota request was issued, so actual quota fields and sustainable five-second quota polling remain unverified.

## Proposed implementation details

- One backend service with SQLite on persistent storage; provide a Dockerfile and deployment instructions.
- Keep Codex account weights configurable by stable account identifier. Explicitly map the x5 and x20 accounts during setup rather than assuming their identity from account order or a generic plan label.
- Show total tokens for the selected period. Live request rows show time, provider/model, outcome, duration, and total tokens when supplied by telemetry.
- Exclude never-observed quota values from the average and show account coverage; retain previously observed values with stale labeling as agreed.
- Use a dedicated RESP subscription for telemetry and server-side management calls for quota. Avoid destructive-polling fallback while coexisting with CPAMP.

## Remaining verification and delivery details

- GitHub repository destination and visibility, to resolve before publishing the finished source.
- Verify stable account identifiers and provider quota payloads, including actual Gemini five-hour/weekly windows and the Codex weight mapping.
- Whether quota sources can support the requested refresh frequency.
- Document direct access to the proxy's RESP listener as a deployment requirement. CPAMP reports subscription transport but must recover from its upstream IP ban observed during the status check. Recommend a separate subscription and local history for this app, without destructive-polling fallback. Verify connectivity where available; GitHub delivery does not require direct server deployment.

The user confirmed shared understanding and approved this product brief on 2026-09-10. Implementation has not started. See [the implementation plan](implementation-plan.md) for the next session; do not restart the requirements interview.
