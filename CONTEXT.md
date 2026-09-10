# Proxy Monitoring

A personal, at-a-glance view of quota and request activity across the user's configured providers.

## Language

**Monitoring display**:
A view for checking quota and request activity at a glance, without controls for managing provider accounts or proxy settings.
_Avoid_: Management console, admin panel

**Provider group**:
A section of the monitoring display containing combined usage and a quota summary for one included provider currently configured in the proxy.
_Avoid_: Combined provider pool

**Provider usage**:
The sum of usage across a provider's accounts over the same reporting period.
_Avoid_: Average usage

**Provider quota remaining**:
The capacity-weighted average of accounts' remaining quota percentages for the same quota model and window. An account's weight represents its allowance relative to a shared baseline.
_Avoid_: Unweighted quota average

**Token usage period**:
The selected reporting period for combined token usage: Today, Week, or Month. This selection does not change provider quota windows or the live request feed.

**Live request feed**:
A view of completed requests updated every five seconds, showing current activity independently of the selected token usage period.
_Avoid_: In-flight requests, instantaneous streaming
