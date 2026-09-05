# Harness Browser Workspace architecture

## Runtime

All runtime processes below are local. Native Host connects the Chrome/Edge
Extension on one side and the local Harness Web/CLI process on the other; it is
not a remote application server.

```text
Harness Sidepanel / Fullscreen iframe
  -> Chrome Extension background
  -> Chrome Native Messaging
  -> installed Native Host
  -> local Harness Web + MCP BrowserConnector
  -> Extension Browser/Office/Knowledge adapters
  -> bound Browser Target
```

- Harness owns models, sessions, permissions, tools, and the workspace UI.
- The Extension owns Chrome permissions, Browser Target revalidation, page
  reads, and same-target Verified Write execution.
- Native Host owns one local Harness process, one Connector, and the active Run
  binding. Connector state is isolated behind `RunTargetRegistry`.
- Browser and Native peers share the runtime contract in
  `apps/native-server/src/transport/connector-protocol.mjs`; message names, correlation,
  Browser Target identity, and response envelopes are not redefined by peers.
- The large runtime entrypoints are now orchestration modules. Connector tool
  schemas live in `connector-tool-catalog.mjs`, Knowledge transport lives in
  `knowledge-transport.mjs`, and Run state lives in `run-target-registry.mjs`.
  Browser Target persistence/revalidation lives in
  `background/browser-target-runtime.ts`; Office and Markdown Review requests
  use their versioned contract modules.

## Product customization

Official Harness remains clean under `upstream/deepseek-harness`. Generic seam
patches are materialized into `.generated/harness-product`; product behavior is
implemented in `packages/*`. The only product-package inventory is
`apps/native-server/src/product-plugin-manifest.mjs`.

## Delivery identity

`sync-harness-assets` and Native Host registration emit
`runtime-manifest.json` identities containing the upstream revision, materialized
product hash, product-plugin hash, and copied-asset hash. Native Host reports
the identity read from its installed copy in `server_started`. The Extension
requires the same upstream revision, product hash, installed-plugin hash, and
product-plugin boot order as its bundled assets, and reports a mismatch instead of silently
using stale runtime code. Asset hashes remain per-artifact diagnostics because
the Native and Extension artifact trees intentionally contain different files.

## Required gates

Run in order:

```sh
pnpm verify:upstream
pnpm typecheck
pnpm typecheck:plugins
pnpm test
pnpm build
```

`pnpm test` includes both root integration tests and every product package test.
Browser-facing changes still require real Chrome or Edge acceptance after the
loaded runtime identity is confirmed.
