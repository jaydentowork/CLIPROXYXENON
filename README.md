# XENEON EDGE

A standalone CLIProxyAPI monitoring display for the 2560 × 720 CORSAIR XENEON EDGE. One Node service collects completed requests into SQLite, caches provider quota, and serves a native browser interface. Antigravity, Claude, and Codex are included; xAI is excluded. There is no dependency on CPAMP's service or database.

## Run locally

Requires Node.js 24.2 or newer, including the built-in `node:sqlite` module.

```sh
npm ci
npm test
npm run demo
```

Open http://127.0.0.1:8787. The demo is visibly labeled **simulated data**. It never contacts upstream or opens the live database. Its synthetic quota windows are for layout demonstration, not evidence of provider capabilities.

For collection, preserve your existing `.env`. Only copy `.env.example` if no `.env` exists, fill in the missing settings, then run:

```sh
npm start
```

`.env` stays on the backend and is excluded from Git and Docker build context. The browser can only read the dashboard snapshot and service health. Upstream account management and arbitrary forwarding are unavailable.

## Configuration

| Variable | Meaning |
| --- | --- |
| `CLIPROXYAPI_BASE_URL` | Management HTTP(S) base. `/v0/management` is appended exactly once. No credentials in the URL. |
| `MANAGEMENT_KEY` | Plaintext management key. Kept on the backend. |
| `CLIPROXYAPI_RESP_URL` | Separate direct `redis://host:port` or `rediss://host:port` usage listener. No HTTP URL or database suffix. |
| `CLIPROXYAPI_RESP_PASSWORD` | Listener authentication; defaults to the management key. |
| `CODEX_ACCOUNT_WEIGHTS` | JSON object mapping the exact stable `auth_index` of each Codex account to `5` or `20`. Empty by default; missing weights are explicitly unknown. |
| `DATA_PATH` | SQLite file, default `./data/dashboard.sqlite`. Use persistent storage. |
| `HOST`, `PORT` | Default `127.0.0.1:8787`. Bind through your existing access layer. |

Never assign Codex weights by list position or infer x5/x20 from a generic Pro label. The two account IDs must be mapped to their known allowances by the operator. Account IDs and weights belong in local configuration, not committed examples. Actual recorded tokens are summed without capacity weights.

The direct RESP listener must be reachable from the backend. A web reverse proxy exposing management HTTPS does **not** automatically expose this TCP/TLS listener. `rediss://` validates the server certificate; a private certificate authority must be configured through Node's standard `NODE_EXTRA_CA_CERTS` mechanism rather than disabling validation. No independent Redis server or RESP database is required.

The collector uses only authentication and `SUBSCRIBE usage`. It does not issue `HELLO`, `INFO`, `SELECT`, client metadata commands, FIFO queue reads, or a polling fallback. Keep CPAMP using a healthy subscription transport too: while subscribers are connected CLIProxyAPI broadcasts records and does not add them to its polling FIFO. This app never changes CPAMP configuration.

## Docker on the proxy server

The following Linux example uses host networking so a listener bound to server loopback remains reachable. Bind the dashboard to loopback and route it through your existing access layer; there is no additional app login.

```sh
docker build -t xeneon-edge:local .
docker volume create xeneon-edge-data
docker run -d --name xeneon-edge --restart unless-stopped \
  --network host --env-file .env \
  -e HOST=127.0.0.1 -e DATA_PATH=/data/dashboard.sqlite \
  -v xeneon-edge-data:/data xeneon-edge:local
```

If using a bridge network instead, configure the RESP address to a reachable proxy-server address, bind the container to `HOST=0.0.0.0`, and publish only to host loopback (`-p 127.0.0.1:8787:8787`). Existing reverse proxy/access-layer details remain deployment-specific. No remote deployment is performed by this repository.

The image runs as the `node` user. For a bind mount, make the data directory writable by that user (UID 1000); the named-volume example preserves image directory ownership. Back up SQLite with its online backup facility or stop the service before copying the database and any WAL files together.

## Data and freshness

Today, Week, and Month use `America/Chicago`, including CST/CDT changes. Weeks start Monday at local midnight; months start on the first. These selections affect token totals only. The recent completed-request feed remains current, refreshed with the dashboard every five seconds. Provider reset windows are independent of calendar reports.

History starts fresh when the service first opens its persistent database. **Tracking since** is durable across restarts, making partial reporting periods visible. Records older than 60 days are removed automatically. Pub/sub has no replay guarantee; known connection gaps are retained and exposed. The service cannot reconstruct requests emitted during a disconnection and does not import CPAMP history.

Quota refresh runs in one coordinated backend schedule, independent of the number of browsers. Unknown readings are never treated as zero or full. Last successful readings remain visible as stale on refresh failure. Partial coverage is shown, and different account reset times are labeled as the next account reset and reset spread. Upstream throttling can make actual quota freshness slower than five seconds.

Antigravity quota bars are restricted to Gemini. Antigravity requests for Claude models still contribute tokens and activity. Public Antigravity data may expose model remaining fraction and reset without identifying five-hour or weekly allowances. The app preserves provider-defined data and labels missing requested windows as unavailable instead of inventing them. See [quota contract](docs/quota-contract.md) and [telemetry contract](docs/telemetry-contract.md).

## Troubleshooting and verification

`npm run probe` makes **one** read-only `/auth-files` request and prints only sanitized status, provider counts, and identifier-field availability. A 401/403 is a stop condition: resolve credentials/access restrictions before manually trying again, because repeated failures can ban the client IP. Never paste credentials into a report. Automatic management authentication retries stop after rejection until service restart.

Collector disconnection means request history may be incomplete. Confirm direct RESP connectivity and the listener's management-key authentication. Unsupported-command errors commonly indicate use of a generic Redis client with an incompatible handshake; this collector sends only the documented subset. Also verify CPAMP's authenticated status independently; its management-panel password is not assumed to equal the proxy management key.

`GET /healthz` reports service availability and collector state. A responsive web service does not mean collection or quota refresh is healthy. The dashboard exposes those states separately.

For the exact checks completed in this implementation environment, and the remaining live-only checks, see [verification](docs/verification.md). Source-backed fixtures and fake RESP tests do not establish live quota payloads, sustainable polling cadence, or current CPAMP health.

## GitHub delivery

The project is prepared for a GitHub repository. Choose a destination and visibility before publishing. Keep `.env`, databases, logs, research downloads, and generated artifacts excluded. Review `git status` and staged paths before the first commit/push. No remote is assumed, no repository is published, and no server deployment is included without an explicit destination.
