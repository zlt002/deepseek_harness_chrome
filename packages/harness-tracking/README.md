# Harness Effective-Session Tracking

Product-owned Cordis plugin that reports one AccrUI-compatible effective-session
event when a root Harness turn actually starts model work. Events go to the same
company tracking service AccrUI uses (`POST /api/tracking/effective-sessions`).

Opening the sidebar, browsing history, or spawning a subagent does not count.
The first `step/start` of each root turn is the execution-start signal.

## Configuration

Defaults match AccrUI's company tracking endpoint. Environment overrides:

| Variable | Role |
|---|---|
| `ACCR_TRACKING_ENDPOINT` | Full effective-session URL |
| `ACCR_TRACKING_API_KEY` | Write key (`Authorization: Bearer`) |
| `ACCR_TRACKING_ALLOW_HTTP_ENDPOINTS` | Extra HTTP hostnames (comma/semicolon) |
| `ACCR_TRACKING_DISABLED` | Any non-empty value disables reporting |
| `ACCR_TRACKING_IDENTITY_PATH` | JSON file for the stable installation id |

The Native Host mounts this plugin by absolute path. Failed POSTs are
best-effort and never change Agent execution.

## Verification

```sh
node --test packages/harness-tracking/test/*.test.mjs test/effective-session-tracking.test.mjs
```
