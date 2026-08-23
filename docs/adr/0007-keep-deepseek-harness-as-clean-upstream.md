# ADR 0007: Keep DeepSeek Harness as a clean upstream dependency

## Status

Accepted.

## Decision

The product repository owns browser integration, Connector behavior, product UI,
Skills, packaging, and compatibility checks. The official DeepSeek Harness
repository is mounted at `upstream/deepseek-harness` as a Git submodule and must
contain no product patches.

Product behavior is added through out-of-tree Cordis plugins and bundles under
`packages/` and `bundles/`. A missing Harness extension seam is proposed
upstream as a generic interface; product-specific behavior does not enter the
upstream checkout.

The accepted pre-migration UI has reached plugin parity. The former full-source
compatibility overlay is retired: the generated product tree has one path only,
clean official Harness plus generic seams plus product plugins.

The product UI is composed from the out-of-tree packages declared in the
product plugin manifest. Their order and participation in build, installation,
injection, typecheck, and test are owned
by `apps/native-server/src/product-plugin-manifest.mjs`. Chain presentation
owners are connected through the generic slot registry using both
`slots.inject(...)` and `select`; the official components retain their default
fallback when a product presentation is absent.

`pnpm verify:upstream` is the local and CI invariant for the recorded upstream
commit and a clean submodule worktree.

## Consequences

- Official Harness upgrades are explicit submodule updates.
- Product changes remain reviewable without generated Harness build output.
- Every upgrade must run `pnpm verify:upstream`, `pnpm typecheck`,
  `pnpm typecheck:plugins`, `pnpm test` (including product package tests), the
  extension build, and release closure checks before it is accepted.
- Native Messaging startup must first verify the exact loaded extension origin
  with `scripts/register-native-host.mjs --check`.
- Asset sync and Native Host registration emit runtime identities. The
  extension compares the loaded Native Host revision and product-plugin hash
  with its own Harness assets before reporting a verified runtime.
- Real macOS Chrome acceptance currently covers Native Messaging through the
  Harness UI, the compact shell, composer knowledge/code scope, model and
  permission controls, Browser Target, and Session Log. Settings, trajectory,
  subagent presentation, and Windows remain separate acceptance gates.
