### Domain docs

This is a single-context repo using root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

## Development practices

These practices are mandatory for all AI-driven development in this repository.
They encode verified lessons from real debugging sessions in this codebase.

### 1. Layer awareness before editing

This repo has four code layers with different reload paths. Identify the layer
before changing anything:

| Layer | Location | How changes take effect |
| --- | --- | --- |
| Extension UI | `apps/chrome-extension` | WXT HMR (automatic) |
| Native Server | `apps/native-server` | Re-register + restart host (`pnpm dev:watch`, or `pnpm dev:restart -- --skip-harness-build`) |
| Product plugins | `packages/*` | `pnpm dev:refresh -- --fast` |
| Harness base / seam patches | `upstream-contributions/`, materialized tree | `pnpm dev:refresh` (slowest) |

The registered Native Host runs from an installed copy under
`~/Library/Application Support/DeepSeekHarness/`, not from the source tree.
Editing `apps/native-server` without re-registering has no effect on the
running browser session. "I changed it but nothing happened" almost always
means the wrong reload path for the layer.

Daily workflow by layer (measured on this machine; full refresh is dominated
by the deliberate from-scratch materialize: fresh clone + patches + full
rebuild of all 54 upstream packages, ~3-4 min total; product plugins
themselves build in ~2 s):

- Extension UI + Native Server (the daily hot loop): run `pnpm dev` and
  `pnpm dev:watch` in two terminals. Saving a file takes effect in seconds;
  the sidepanel reconnects to a restarted Native Host automatically.
- Product plugins (`packages/*`): `pnpm dev:refresh -- --fast` (~20 s; skips
  re-materializing the Harness base).
- Full `pnpm dev:refresh` is only for: seam patch changes, upstream submodule
  moves, or a corrupted/missing `.generated/harness-product` tree. Do not run
  it as part of the daily loop. If the sidepanel reports
  "DeepSeek Harness CLI was not found" right after a refresh, it was a
  rebuild-window race: the tree completes only in the final seconds, so wait
  for the refresh to finish and reopen the sidepanel.

### 1b. Plugin development is the main customization path

Most product work is customizing Harness by writing out-of-tree plugins under
`packages/` — this is the primary development activity, not an edge case.
Treat the official upstream docs as the authoritative how-to source; do not
guess Cordis/DSH APIs from memory:

- Read `upstream/deepseek-harness/docs/cookbook/extension-cookbook.zh.md`
  first for the plugin archetypes (tool plugins, hook plugins, UI plugins).
- Tool plugins: `upstream/deepseek-harness/docs/cookbook/adding-a-tool.md`.
- UI plugins / conversation nodes:
  `upstream/deepseek-harness/docs/cookbook/adding-a-conversation-node.md`.
- Package structure checklist:
  `upstream/deepseek-harness/docs/cookbook/adding-a-package.md`.
- Cordis primer and API reference live under `upstream/deepseek-harness/docs/`
  (`cordis-primer.zh.md`, `cordis-api/`).

Plugin authoring rules specific to this repo:

- Copy an existing sibling plugin (e.g. `packages/harness-ui-browser-target`)
  as the structural template: `src/` + `tsdown.config.ts` + `lib/` output +
  `test/` with a package-contract test + `dsh.client.inject` declarations in
  `package.json`.
- New plugins must be registered in every plugin list or they will silently
  not ship: `productPluginNames` in `scripts/register-native-host.mjs`, the
  plugin list in `scripts/build-harness-client-plugins.mjs`, and the
  `typecheck:plugins` chain in the root `package.json`.
- Verify against the materialized tree (`.generated/harness-product`), never
  against `upstream/` sources directly (see red lines).
- A new UI plugin usually also needs a seam: check
  `upstream-contributions/README.md` for the generic slot registry before
  inventing ad-hoc DOM injection.

### 2. Verification chain (run before every commit, in order)

```sh
pnpm verify:upstream        # submodule pinned commit + clean worktree
pnpm typecheck              # extension types
pnpm typecheck:plugins      # plugin types
pnpm test                   # full regression suite
pnpm build                  # build artifacts
```

Changed behavior requires a matching test. The suite is built from cross-layer
contract tests; a behavior change without a test will be flagged in review.

### 3. Architecture red lines (ADR-enforced)

- Never modify `upstream/deepseek-harness`. `pnpm verify:upstream` is the CI
  invariant; violations block merges.
- Product behavior belongs in `packages/`. Only generic, product-neutral
  seams missing from official Harness go into `upstream-contributions/` as
  patches; patches must not contain product names.
- Plugins must not import files under `upstream/deepseek-harness/packages/**/src`.
  Public Service Definitions only.
- Use the vocabulary of `CONTEXT.md` (Browser Target, not "active tab";
  Verified Write, not "write succeeded"). See `docs/agents/domain.md`.

### 4. Connector rules

- Errors must stay transparent end to end. Never replace a specific error
  with a generic message; downstream models cannot recover information they
  never receive. If a failure is fast (~20 ms), the real cause exists in the
  Extension reply; if it is slow (~15 s), it is a pipe timeout.
- Verified Write is mandatory for mutations: read, verify fingerprint, write,
  read back. No step may be skipped (ADR-0004, ADR-0006).
- After changing `apps/native-server`, sync the installed host and stop old
  host processes before browser verification. Reopen the sidepanel to start
  the new code.

### 5. Debugging practices

- Register the Native Host with `DSH_NATIVE_LOG=/tmp/deepseek-harness-native-host.log`
  for frame-level diagnostics (already redacted).
- For suspected behavior bugs, write a self-contained reproduction script under
  `output/repro-*.mjs` that instantiates `BrowserConnector` / `NativeHost`
  directly (no Chrome needed). Existing scripts in `output/` are templates.
- Timeout errors vs instant errors distinguish pipe timeouts from Extension
  failures; check tool-call latency before guessing causes.

### 6. Release and upstream upgrades

- Mac package: `pnpm release:mac-production-poc`.
- Windows runtime must be materialized on a Windows x64 build host
  (`pnpm materialize:windows-harness-runtime`); never copy native deps from
  macOS. CI runs install, registration, upgrade, rollback, and user-data
  preservation checks.
- Upgrading upstream: move the pinned submodule commit only, then
  `pnpm verify:upstream`, `pnpm build:harness-product`, `pnpm typecheck:plugins`,
  `pnpm test`, `pnpm build`. Update `upstream-contributions/*.patch` on
  conflict; never fix patches inside the submodule.
