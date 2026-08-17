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

Until those plugins reach side-by-side visual and interaction parity, the
accepted pre-migration UI is preserved as a compatibility overlay under
`product-overlays/`. The overlay applies only to the disposable generated
product tree. Removing an accepted behavior requires parity evidence, not only
an architectural replacement.

`pnpm verify:upstream` is the local and CI invariant for the recorded upstream
commit and a clean submodule worktree.

## Consequences

- Official Harness upgrades are explicit submodule updates.
- Product changes remain reviewable without generated Harness build output.
- Every upgrade must run product plugin tests, the extension build, and release
  closure checks before it is accepted.
