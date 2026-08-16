# Harness Runtime MCP Scopes

Product-owned Cordis plugin for an MCP server whose tools have two visibility levels:

- `global`: registered on the parent/application context.
- `continuable-child`: registered through the public `ctx.subagents.registerContinuableSetup()` lifecycle seam, so it exists only in continuable child agents and is installed before that child is published.

It also optionally forwards the trusted Harness session and parent-session IDs in MCP `_meta`. Those values are not model-visible.

## Configuration

```yaml
- id: accrui-mcp-scopes
  name: /absolute/path/to/packages/harness-runtime/src/index.mjs
  config:
    serverName: chrome
    url: http://127.0.0.1:49299/mcp
    headers:
      Authorization: Bearer token
    forwardSessionIdentity: true
    toolScopes:
      default: global
      code_search: continuable-child
      knowledge_search: continuable-child
```

`toolScopes` keys are raw MCP names, not `mcp__chrome__...` names. The plugin does not change `ToolRuntime.restrict()` or the continuation manager; it relies on the public child-setup contract so the runtime decides ordering and disposal.

## Verification

```sh
node --test packages/harness-runtime/test/*.test.mjs
```

Residual risk: this package requires a Harness release exposing `ctx.subagents.registerContinuableSetup()`. On an older release it fails at load rather than silently registering private tools too late or exposing them globally.
