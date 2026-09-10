# Independent apps with broadcast usage subscriptions

The standalone dashboard must own its collector and history while CPAMP continues receiving the same usage data. Use one backend collector within this app, subscribing independently to `SUBSCRIBE usage`; its browser clients read only this app's backend. Keep history in this app's own persistent SQLite database, start fresh, and retain request records for 60 days.

The [Redis usage-queue documentation](https://help.router-for.me/management/redis-usage-queue.html) says subscriptions broadcast new records to all connected subscribers. While any subscriber is connected, new records do not enter the FIFO queue, so neither competing destructive consumers nor mixing subscription and polling satisfies coexistence. Do not fall back to `GET /usage-queue`, `LPOP`, or `RPOP`; do not depend on CPAMP's API or database for normal operation.

On 2026-09-10, a read-only check confirmed the deployed CPAMP reported `mode: auto` and `transport: subscribe`, but its collector was in an error state due to an upstream IP ban. Recovery and direct RESP connectivity from the new app's deployment still need verification. Subscriptions do not provide durable replay for disconnected clients; expose connection failures and known collection gaps instead of claiming complete history during an outage.
